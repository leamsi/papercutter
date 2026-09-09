import { useEffect, useState } from "preact/hooks";
import { Alert } from "@silverbulletmd/silverbullet/ui";
import { api, formatApiError } from "../api.ts";
import { bindingLabel, spaceEntryUrl } from "../bindings.ts";
import { spacesUrl } from "../routes.ts";
import type { VisibleSpace } from "../types.ts";

/**
 * The landing screen for *every* authenticated account, so it reads the
 * account-scoped `api/spaces` rather than the admin listing: an ordinary
 * member sees the spaces it may open, an admin additionally gets an Edit
 * control per row and the create button.
 */
export function SpaceList({
  admin,
  onUnauthorized,
}: {
  admin: boolean;
  onUnauthorized: () => void;
}) {
  const [spaces, setSpaces] = useState<VisibleSpace[]>([]);
  const [encryptedLogin, setEncryptedLogin] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const encrypt = !!localStorage.getItem("enableEncryption");
    const central = encrypt
      ? fetch("/.auth/central/public").then(
          async (response) =>
            response.ok && !!(await response.json()).configured,
        )
      : Promise.resolve(false);
    Promise.all([api("GET", "api/spaces"), central])
      .then(([spaces, configured]: [VisibleSpace[], boolean]) => {
        setEncryptedLogin(configured);
        setSpaces(spaces);
        setLoaded(true);
      })
      .catch((error: any) => {
        if (error.unauthorized) onUnauthorized();
        else {
          setError(formatApiError(error));
          setLoaded(true);
        }
      });
  }, []);

  return (
    <div>
      {/* Admins reach this screen through the tab bar, which already names it;
          a heading repeating "Spaces" directly under the active tab is pure
          duplication. Non-admins have a tab bar too (Profile), but no tab of
          theirs says "Spaces" -- so the heading is still what labels this
          screen for them. */}
      {!admin && <h1>Spaces</h1>}
      {error && <Alert variant="error">{error}</Alert>}
      {!loaded && <p>Loading…</p>}
      {loaded && spaces.length === 0 && (
        <p>
          {admin
            ? "No spaces yet — create your first space."
            : "You don't have access to any spaces yet."}
        </p>
      )}
      <ul class="sb-space-list">
        {spaces.map((space) => (
          <li key={space.id}>
            <a
              class="sb-space-link"
              href={spaceEntryUrl(space.binding, encryptedLogin)}
            >
              {space.name}
            </a>
            <a
              href={spaceEntryUrl(space.binding, encryptedLogin)}
              target="_blank"
              rel="noopener"
            >
              {bindingLabel(space.binding)}
            </a>
            {admin && (
              <a
                class="sb-button sb-space-edit"
                href={spacesUrl(`/${encodeURIComponent(space.id)}`)}
              >
                Edit
              </a>
            )}
          </li>
        ))}
      </ul>
      {loaded && admin && (
        <div class="row">
          <a class="sb-button sb-button-primary" href={spacesUrl("/new")}>
            Create space
          </a>
        </div>
      )}
    </div>
  );
}
