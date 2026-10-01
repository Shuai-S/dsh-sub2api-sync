/**
 * The account block's sign-in dialog: one `Modal` owned by the settings
 * section, walking the PAT and password (+2FA) channels. Phases are derived
 * from the flow state — `pat` and `password` are the user-chosen channel,
 * `2fa` appears only after the host reports a two-factor requirement. A
 * successful sign-in closes the dialog; the section refreshes status and
 * groups through the `onSignedIn` callback.
 *
 * @module sub2api-sync/client/section/SignInDialog
 */

import { useEffect, useState } from 'react'
import { Button, Input, Modal, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Sub2apiSyncConfig } from '../../config.ts'
import { setField, unsetField } from '../useConfigForm.ts'
import type { NS } from '../locales.ts'
import type { PluginApi } from '../usePluginApi.ts'

type SignInChannel = 'pat' | 'password'
type SignInPhase = SignInChannel | '2fa'

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
  /** Called after a successful sign-in (PAT or password/2FA). */
  onSignedIn: () => void
}

/**
 * The account block's login form. Two channels ship today:
 * - C1 PAT paste (`POST /pat`);
 * - C3 password + optional 2FA (`POST /login`, then `POST /login/2fa`).
 *
 * TODO(C2): the 网页授权 channel rides `POST /oauth/start` → the real sub2api
 * login page in a new tab → `GET /oauth/callback`, and is added here as a
 * third SegmentedControl segment once the self-hosted OAuth endpoints exist
 * (design note §12-B). Its dialog phases derive from `GET /oauth/status`.
 */
export function SignInDialog({ open, onClose, api, config, baseURL, writable, onSignedIn, t }: SignInDialogProps) {
  const [phase, setPhase] = useState<SignInPhase>('pat')
  const [channel, setChannel] = useState<SignInChannel>('pat')
  const [address, setAddress] = useState('')
  const [token, setToken] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  // Reopening seeds the address from the committed value; closing drops drafts.
  useEffect(() => {
    if (open) {
      setAddress(baseURL ?? '')
      return
    }
    setPhase('pat')
    setChannel('pat')
    setToken('')
    setEmail('')
    setPassword('')
    setCode('')
    setBusy(false)
    setError(undefined)
  }, [open, baseURL])

  const pickChannel = (next: SignInChannel): void => {
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

  const connectPat = (): void => {
    void run(async () => {
      await commitAddress()
      await api.pat(token.trim())
      finish()
    })
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

  const footer = (
    <div className="s2s-actions">
      {phase === '2fa' && (
        <Button variant="outline" disabled={busy} onClick={() => pickChannel('password')}>{t('back')}</Button>
      )}
      <Button variant="ghost" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
      {phase === 'pat' && (
        <Button variant="primary" disabled={busy || token.trim().length === 0 || address.trim().length === 0} onClick={connectPat}>
          {t('connect')}
        </Button>
      )}
      {phase === 'password' && (
        <Button variant="primary" disabled={busy || email.trim().length === 0 || address.trim().length === 0} onClick={submitPassword}>
          {t('signIn')}
        </Button>
      )}
      {phase === '2fa' && (
        <Button variant="primary" disabled={busy || code.trim().length !== 6} onClick={submit2fa}>
          {t('twoFactorSubmit')}
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
            disabled={busy || !writable || phase === '2fa'}
            onChange={(event) => { setAddress(event.target.value) }}
          />
        </div>
        {phase !== '2fa' && (
          <div className="s2s-inline">
            <span className="s2s-fieldLabel">{t('channelLabel')}</span>
            <SegmentedControl<SignInChannel>
              id="sub2api-sync-signin-channel"
              value={channel}
              options={[
                { value: 'pat', label: t('channelPat') },
                { value: 'password', label: t('channelPassword') },
              ]}
              onChange={pickChannel}
              label={t('channelLabel')}
              disabled={busy}
            />
          </div>
        )}
        {phase === 'pat' && (
          <Input
            type="password"
            value={token}
            placeholder={t('patPlaceholder')}
            disabled={busy}
            autoFocus
            onChange={(event) => { setToken(event.target.value) }}
          />
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
