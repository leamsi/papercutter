import { Alert, Button, Input } from "@silverbulletmd/silverbullet/ui";
import { useEffect, useState } from "preact/hooks";
import { adminApi, formatApiError } from "../api.ts";
import { SaveConfirmation, useNotification } from "../notifications.tsx";
import { updateServerName } from "../server_name.ts";

export function ServerSettingsView({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}) {
  const [config, setConfig] = useState<{
    primaryUrl: string | null;
    serverName: string;
  }>();
  const [serverName, setServerName] = useState("SilverBullet");
  const [primaryUrl, setPrimaryUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const notify = useNotification("server");

  function handleError(error: any) {
    if (error.unauthorized) onUnauthorized();
    else setError(formatApiError(error));
  }

  useEffect(() => {
    void adminApi("GET", "server-config")
      .then((value) => {
        setConfig(value);
        setServerName(value.serverName ?? "SilverBullet");
        setPrimaryUrl(value.primaryUrl ?? location.origin);
      })
      .catch(handleError);
  }, []);

  async function save() {
    setBusy(true);
    setError("");
    notify("");
    try {
      const value = await adminApi("PUT", "server-config", {
        primaryUrl: primaryUrl.trim(),
        serverName: serverName.trim(),
      });
      setConfig(value);
      setServerName(value.serverName);
      updateServerName(value.serverName);
      setPrimaryUrl(value.primaryUrl);
      notify("Server settings saved.");
      if (new URL(value.primaryUrl).origin !== location.origin) {
        location.href = `${value.primaryUrl}/.spaces/admin?section=server`;
      }
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error && <Alert variant="error">{error}</Alert>}
      {!config && !error && <p>Loading…</p>}
      {config && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <SaveConfirmation scope="server" />
          <label for="server-name">Server Name</label>
          <Input
            id="server-name"
            required
            maxLength={100}
            value={serverName}
            onInput={(event) => setServerName(event.currentTarget.value)}
          />
          <label for="server-primary-url">Primary URL</label>
          <Input
            id="server-primary-url"
            type="url"
            required
            value={primaryUrl}
            onInput={(event) => {
              setPrimaryUrl(event.currentTarget.value);
            }}
          />
          <p class="sb-help-text">
            The address for server management and sign-in.
          </p>
          <Button type="submit" variant="primary" disabled={busy}>
            Save
          </Button>
        </form>
      )}
    </div>
  );
}
