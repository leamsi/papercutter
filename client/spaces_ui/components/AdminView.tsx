import { Select } from "@silverbulletmd/silverbullet/ui";
import { ADMIN_SECTIONS, type AdminSection, spacesUrl } from "../routes.ts";
import { useNavigate } from "../navigation.ts";
import { ServerSettingsView } from "./ServerSettingsView.tsx";
import { AuthenticationView } from "./AuthenticationView.tsx";

export function AdminView({
  section,
  onUnauthorized,
}: {
  section: AdminSection;
  onUnauthorized: () => void;
}) {
  const navigate = useNavigate();
  const sectionUrl = (key: string) => spacesUrl(`/admin?section=${key}`);
  return (
    <main class="sb-space-settings">
      <header class="sb-settings-heading">
        <div>
          <h1>Admin</h1>
        </div>
      </header>
      <div class="sb-settings-layout">
        <nav class="sb-settings-sidebar" aria-label="Admin settings">
          {Object.entries(ADMIN_SECTIONS).map(([key, label]) => (
            <a
              key={key}
              href={sectionUrl(key)}
              aria-current={section === key ? "page" : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
        <div class="sb-settings-mobile">
          <label for="admin-settings-section">Settings section</label>
          <Select
            id="admin-settings-section"
            value={section}
            onChange={(event) =>
              navigate(sectionUrl(event.currentTarget.value))
            }
          >
            {Object.entries(ADMIN_SECTIONS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <div class="sb-settings-content">
          <h2>{ADMIN_SECTIONS[section]}</h2>
          {section === "server" ? (
            <ServerSettingsView onUnauthorized={onUnauthorized} />
          ) : (
            <AuthenticationView onUnauthorized={onUnauthorized} />
          )}
        </div>
      </div>
    </main>
  );
}
