/**
 * The account block's sign-in dialog: one `Modal` owned by the settings
 * section, walking the password (+2FA) and web authorization channels.
 * Phases are derived from the flow state — `password` and `oauth` are
 * the user-chosen channel, `2fa` appears only after the host reports a
 * two-factor requirement, and `oauth-pending` polls the host attempt while
 * the user finishes the grant in the browser. A successful sign-in closes
 * the dialog; the section refreshes status and groups via `onSignedIn`.
 *
 * @module sub2api-sync/client/section/SignInDialog
 */

import { useEffect, useRef, useState } from 'react'
import { Button, Input, Modal, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Sub2apiSyncConfig } from '../../config.ts'
import { setField, unsetField } from '../useConfigForm.ts'
import type { NS } from '../locales.ts'
import type { PluginApi } from '../usePluginApi.ts'

type SignInChannel = 'password' | 'oauth'
type SignInPhase = SignInChannel | '2fa' | 'oauth-pending'

const OAUTH_POLL_MS = 2000

/** Dialog props: locale seat plus the plugin API face and close/success callbacks. */
export interface SignInDialogProps extends PropsLocale<typeof NS> {
  open: boolean
  onClose: () => void
  api: PluginApi
  /** The plugin's configuration form: the instance address commits here on connect. */
  config: ConfigForm<Sub2apiSyncConfig>
  /** Current committed instance address (draft seed). */
  baseURL: string | undefined
  /** Whether configuration writes are accepted (process-local mode read-only). */
  writable: boolean
  /** Called after a successful sign-in (password/2FA or web authorization). */
  onSignedIn: () => void
}

/**
 * The account block's login form. Two channels ship:
 * - C3 password + optional 2FA (`POST /login`, then `POST /login/2fa`);
 * - C2 web authorization (`POST /oauth/start` → provider consent tab →
 *   `GET /oauth/callback`; this dialog polls `GET /oauth/status`).
 */
export function SignInDialog({ open, onClose, api, config, baseURL, writable, onSignedIn, t }: SignInDialogProps) {
  const [phase, setPhase] = useState<SignInPhase>('password')
  const [channel, setChannel] = useState<SignInChannel>('password')
  const [address, setAddress] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [authorizeUrl, setAuthorizeUrl] = useState<string | undefined>(undefined)
  const attemptRef = useRef<string | undefined>(undefined)
  // Whether the user hand-picked a channel in this dialog session; while
  // untouched, the address probe may auto-switch (a manual pick always wins).
  const channelTouchedRef = useRef(false)

  // Reopening seeds the address from the committed value; closing drops drafts.
  useEffect(() => {
    if (open) {
      setAddress(baseURL ?? '')
      channelTouchedRef.current = false
      return
    }
    setPhase('password')
    setChannel('password')
    setEmail('')
    setPassword('')
    setCode('')
    setBusy(false)
    setError(undefined)
    setAuthorizeUrl(undefined)
    attemptRef.current = undefined
  }, [open, baseURL])

  // Channel auto-detection: once the address settles (600ms debounce), probe
  // whether the instance publishes OAuth discovery metadata and preselect the
  // channel accordingly. A manual pick (channelTouchedRef) is never overridden.
  useEffect(() => {
    if (!open) return
    const value = address.trim()
    if (!/^https?:\/\//i.test(value)) return
    if (phase !== 'password' && phase !== 'oauth') return
    const timer = setTimeout(() => {
      void api.oauthProbe(value).then((answer) => {
        if (channelTouchedRef.current) return
        const next: SignInChannel = answer.supported ? 'oauth' : 'password'
        setChannel(next)
        setPhase((prev) => (prev === 'password' || prev === 'oauth' ? next : prev))
      }).catch(() => undefined)
    }, 600)
    return () => { clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, open, phase])

  // The pending phase polls the host attempt; every other phase stops it.
  useEffect(() => {
    if (phase !== 'oauth-pending') return
    let stopped = false
    const timer = setInterval(() => {
      const attemptId = attemptRef.current
      if (attemptId === undefined) return
      void api.oauthStatus(attemptId).then((status) => {
        if (stopped) return
        if (status.auth.signedIn && status.auth.kind === 'oauth') {
          finish()
          return
        }
        const attempt = status.attempt
        if (attempt === undefined) {
          stop()
          setError(t('oauthFailed', { message: 'expired' }))
          setPhase('oauth')
          return
        }
        if (attempt.phase === 'completed') {
          finish()
          return
        }
        if (attempt.phase === 'failed') {
          stop()
          setError(t('oauthFailed', { message: attempt.error ?? 'unknown' }))
          setPhase('oauth')
        }
      }).catch(() => undefined)
    }, OAUTH_POLL_MS)
    const stop = (): void => {
      stopped = true
      clearInterval(timer)
    }
    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const pickChannel = (next: SignInChannel): void => {
    channelTouchedRef.current = true
    setChannel(next)
    setPhase(next)
    setError(undefined)
  }

  const finish = (): void => {
    onSignedIn()
    onClose()
  }

  /** Commit the address draft before authenticating; aborts the flow on refusal. */
  const commitAddress = async (): Promise<void> => {
    const value = address.trim()
    if (value === (baseURL ?? '')) return
    const accepted = await (value.length === 0 ? unsetField(config, 'baseURL') : setField(config, 'baseURL', value))
    if (!accepted) throw new Error(t('writeRefused'))
  }

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const openAuthorizeTab = (url: string | undefined): void => {
    if (url === undefined) return
    window.open(url, '_blank', 'noopener')
  }

  const submitPassword = (): void => {
    void run(async () => {
      await commitAddress()
      const response = await api.login(email.trim(), password.length > 0 ? password : undefined)
      if (response.kind === '2fa') {
        setPhase('2fa')
        return
      }
      finish()
    })
  }

  const submit2fa = (): void => {
    void run(async () => {
      await api.login2fa(code.trim())
      finish()
    })
  }

  const startOauth = (): void => {
    void run(async () => {
      await commitAddress()
      const started = await api.oauthStart()
      attemptRef.current = started.attemptId
      setAuthorizeUrl(started.authorizeUrl)
      openAuthorizeTab(started.authorizeUrl)
      setPhase('oauth-pending')
    })
  }

  const cancelOauth = (): void => {
    const attemptId = attemptRef.current
    attemptRef.current = undefined
    if (attemptId !== undefined) void api.oauthCancel(attemptId).catch(() => undefined)
    setPhase('oauth')
  }

  const footer = (
    <div className="s2s-actions">
      {phase === '2fa' && (
        <Button variant="outline" disabled={busy} onClick={() => pickChannel('password')}>{t('back')}</Button>
      )}
      {phase === 'oauth-pending' && (
        <Button variant="outline" disabled={busy} onClick={cancelOauth}>{t('back')}</Button>
      )}
      <Button variant="ghost" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
      {phase === 'password' && (
        <Button variant="primary" disabled={busy || email.trim().length === 0 || address.trim().length === 0} onClick={submitPassword}>
          {t('signIn')}
        </Button>
      )}
      {phase === 'oauth' && (
        <Button variant="primary" disabled={busy || address.trim().length === 0} onClick={startOauth}>
          {t('oauthStart')}
        </Button>
      )}
    </div>
  )

  return (
    <Modal open={open} onClose={onClose} title={t('signInTitle')} closeLabel={t('close')} footer={footer}>
      <div className="s2s-column">
        <div className="s2s-inline">
          <span className="s2s-fieldLabel">{t('baseURLLabel')}</span>
          <Input
            className="s2s-input"
            type="text"
            value={address}
            placeholder={t('baseURLPlaceholder')}
            disabled={busy || !writable || phase === '2fa' || phase === 'oauth-pending'}
            onChange={(event) => { setAddress(event.target.value) }}
          />
        </div>
        {phase !== '2fa' && phase !== 'oauth-pending' && (
          <div className="s2s-inline">
            <span className="s2s-fieldLabel">{t('channelLabel')}</span>
            <SegmentedControl<SignInChannel>
              id="sub2api-sync-signin-channel"
              value={channel}
              options={[
                { value: 'password', label: t('channelPassword') },
                { value: 'oauth', label: t('channelOAuth') },
              ]}
              onChange={pickChannel}
              label={t('channelLabel')}
              disabled={busy}
            />
          </div>
        )}
        {phase === 'password' && (
          <>
            <Input
              type="email"
              value={email}
              placeholder={t('emailPlaceholder')}
              disabled={busy}
              autoFocus
              onChange={(event) => { setEmail(event.target.value) }}
            />
            <Input
              type="password"
              value={password}
              disabled={busy}
              placeholder={t('passwordLabel')}
              onChange={(event) => { setPassword(event.target.value) }}
            />
            <span className="s2s-hint">{t('passwordHint')}</span>
          </>
        )}
        {phase === 'oauth' && (
          <span className="s2s-hint">{t('oauthReadyHint')}</span>
        )}
        {phase === 'oauth-pending' && (
          <div className="s2s-column">
            <span className="s2s-hint">{t('oauthPendingTitle')}</span>
            <span className="s2s-hint">{t('oauthPendingHint')}</span>
            {authorizeUrl !== undefined && (
              <Button variant="outline" onClick={() => { openAuthorizeTab(authorizeUrl) }}>
                {t('oauthOpenAgain')}
              </Button>
            )}
          </div>
        )}
        {phase === '2fa' && (
          <Input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={code}
            placeholder={t('twoFactorPlaceholder')}
            disabled={busy}
            autoFocus
            onChange={(event) => { setCode(event.target.value.replace(/\D/g, '')) }}
          />
        )}
        {error !== undefined && <p className="s2s-feedback s2s-feedbackError">{t('actionFailedLabel', { message: error })}</p>}
      </div>
    </Modal>
  )
}
