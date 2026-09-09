import { useState } from "preact/hooks";
import {
  Alert,
  Button,
  Checkbox,
  Input,
} from "@silverbulletmd/silverbullet/ui";

export type LoginValues = {
  username: string;
  password: string;
  rememberMe: boolean;
  clientEncryption: boolean;
};

export function LoginForm({
  title,
  error,
  busy,
  rememberMeDays,
  clientEncryption = false,
  clientEncryptionHint,
  initialClientEncryption = false,
  children,
  onSubmit,
  providerLabel,
  onProvider,
}: {
  title: preact.ComponentChildren;
  error?: string;
  busy?: boolean;
  /** Show "Remember me (N days)" when set. */
  rememberMeDays?: number;
  /** Show the client-encryption opt-in. */
  clientEncryption?: boolean;
  /** Explanatory line under the client-encryption option, when it needs one. */
  clientEncryptionHint?: string;
  initialClientEncryption?: boolean;
  /** Extra content below the form (e.g. the login page's footer link). */
  children?: preact.ComponentChildren;
  providerLabel?: string;
  onProvider?: (values: LoginValues) => void;
  onSubmit: (values: LoginValues) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [encrypt, setEncrypt] = useState(initialClientEncryption);

  return (
    <form
      class="flow"
      id="login"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          username,
          password,
          rememberMe,
          clientEncryption: clientEncryption && encrypt,
        });
      }}
    >
      <h1>{title}</h1>
      {error && <Alert variant="error">{error}</Alert>}
      {providerLabel && onProvider && (
        <>
          <Button
            disabled={busy}
            onClick={() =>
              onProvider({
                username: "",
                password: "",
                rememberMe,
                clientEncryption: clientEncryption && encrypt,
              })
            }
          >
            {providerLabel}
          </Button>
          <div role="separator">or use a local account</div>
        </>
      )}
      <div>
        <label for="username">Username</label>
        <Input
          id="username"
          name="username"
          autocapitalize="off"
          autocomplete="username"
          autocorrect="off"
          autoFocus
          value={username}
          onInput={(event) => setUsername(event.currentTarget.value)}
        />
      </div>
      <div>
        <label for="password">Password</label>
        <div class="password-field">
          <Input
            id="password"
            name="password"
            type={revealed ? "text" : "password"}
            autocomplete="current-password"
            value={password}
            onInput={(event) => setPassword(event.currentTarget.value)}
          />
          <Button
            id="togglePassword"
            aria-label={revealed ? "Hide password" : "Show password"}
            onClick={() => setRevealed((shown) => !shown)}
          >
            {revealed ? "Hide" : "Show"}
          </Button>
        </div>
      </div>
      {rememberMeDays !== undefined && (
        <div class="checkbox-wrapper">
          <Checkbox
            id="rememberMe"
            checked={rememberMe}
            onChange={(event) => setRememberMe(event.currentTarget.checked)}
          />
          <label for="rememberMe">Remember me ({rememberMeDays} days)</label>
        </div>
      )}
      {clientEncryption && (
        <div>
          <div class="checkbox-wrapper">
            <Checkbox
              id="clientEncryption"
              checked={encrypt}
              onChange={(event) => setEncrypt(event.currentTarget.checked)}
            />
            <label for="clientEncryption">
              Encrypt local data on this device
            </label>
          </div>
          {clientEncryptionHint && encrypt && (
            <span class="sb-help-text">{clientEncryptionHint}</span>
          )}
        </div>
      )}
      <div style="--space: 1.8rem">
        <Button type="submit" variant="primary" disabled={busy}>
          Log in
        </Button>
      </div>
      {children}
    </form>
  );
}
