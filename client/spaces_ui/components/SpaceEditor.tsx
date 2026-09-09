import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "preact/hooks";
import { Alert, Select } from "@silverbulletmd/silverbullet/ui";
import { adminApi, formatApiError } from "../api.ts";
import { spaceUrl } from "../bindings.ts";
import { setNavigationGuard, useNavigate } from "../navigation.ts";
import { spacesUrl } from "../routes.ts";
import { SPACE_SECTIONS, type SpaceSection } from "../space_settings.ts";
import type { SpaceInfo } from "../types.ts";
import { SpaceForm } from "./SpaceForm.tsx";
import { GitSyncPage } from "./GitSyncPage.tsx";

export function SpaceEditor({
  id,
  section = "general",
  onUnauthorized,
}: {
  id?: string;
  section?: SpaceSection;
  onUnauthorized: () => void;
}) {
  const navigate = useNavigate();
  const leaving = useRef(false);
  const [space, setSpace] = useState<SpaceInfo>();
  const [loaded, setLoaded] = useState(!id);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState<SpaceSection[]>([]);
  const [gitDirty, setGitDirty] = useState(false);
  const [gitEditing, setGitEditing] = useState(false);
  const gitDraftChanged = useCallback((open: boolean, changed: boolean) => {
    setGitEditing(open);
    setGitDirty(changed);
  }, []);
  const [visitedGit, setVisitedGit] = useState(section === "revisions");
  const base = spacesUrl(`/${encodeURIComponent(id ?? "")}`);
  const sectionUrl = (value: SpaceSection) =>
    value === "general" ? base : `${base}?section=${value}`;
  const isDirty = (value: SpaceSection) =>
    dirty.includes(value) || (value === "revisions" && gitDirty);
  const pending = dirty.length > 0 || gitDirty;

  useEffect(() => {
    if (section === "revisions") setVisitedGit(true);
  }, [section]);
  useLayoutEffect(() => {
    if (!pending) return;
    const release = setNavigationGuard((destination) => {
      if (leaving.current) return true;
      const url = new URL(destination ?? "", location.href);
      if (
        destination &&
        url.origin === location.origin &&
        [base, `${base}/git`].includes(url.pathname.replace(/\/+$/, ""))
      )
        return true;
      return window.confirm("Discard your unsaved space settings and leave?");
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (leaving.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      release();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [pending, base]);
  useEffect(() => {
    if (!id) return;
    let active = true;
    adminApi("GET", `spaces/${encodeURIComponent(id)}`)
      .then((value) => {
        if (active) {
          setSpace(value);
          setLoaded(true);
        }
      })
      .catch((cause: any) => {
        if (!active) return;
        if (cause.unauthorized) onUnauthorized();
        else if (cause.notFound) setNotFound(true);
        else setError(formatApiError(cause));
        setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [id]);
  const saved = useCallback(
    (savedId: string, patch?: Partial<SpaceInfo>) => {
      if (!id) navigate(spacesUrl(`/${encodeURIComponent(savedId)}`));
      else setSpace((value) => value && { ...value, ...patch });
    },
    [id, navigate],
  );

  if (!loaded) return <p>Loading…</p>;
  if (notFound)
    return (
      <>
        <h1>Space not found</h1>
        <a href={spacesUrl("/")}>Return to spaces</a>
      </>
    );
  if (error) return <Alert variant="error">{error}</Alert>;
  const form = (
    <SpaceForm
      id={id}
      initial={space}
      section={section}
      onSaved={saved}
      onDirtyChange={setDirty}
      connectionDraft={gitEditing}
      cancelHref={spacesUrl("/")}
      onDeleted={() => {
        leaving.current = true;
        setDirty([]);
        setGitDirty(false);
        location.assign(spacesUrl("/"));
      }}
      onUnauthorized={onUnauthorized}
    />
  );
  if (!id || !space) return form;
  return (
    <main class="sb-space-settings">
      <a href={spacesUrl("/")}>← All spaces</a>
      <header class="sb-settings-heading">
        <div>
          <h1>{space.name}</h1>
        </div>
        <a
          class="sb-button"
          href={spaceUrl(space.binding)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open space ↗
        </a>
      </header>
      <div class="sb-settings-layout">
        <nav class="sb-settings-sidebar" aria-label="Space settings">
          {Object.entries(SPACE_SECTIONS).map(([key, label]) => (
            <a
              key={key}
              href={sectionUrl(key as SpaceSection)}
              aria-current={section === key ? "page" : undefined}
              data-dirty={isDirty(key as SpaceSection) || undefined}
            >
              {label}
            </a>
          ))}
        </nav>
        <div class="sb-settings-mobile">
          <label for="settings-section">Settings section</label>
          <Select
            id="settings-section"
            value={section}
            onChange={(event) =>
              navigate(sectionUrl(event.currentTarget.value as SpaceSection))
            }
          >
            {Object.entries(SPACE_SECTIONS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
                {isDirty(key as SpaceSection) ? " •" : ""}
              </option>
            ))}
          </Select>
        </div>
        <div class="sb-settings-content">
          {form}
          {visitedGit && (
            <div hidden={section !== "revisions"}>
              <GitSyncPage
                spaceId={id}
                spaceInfo={space}
                onDraftChange={gitDraftChanged}
                onUnauthorized={onUnauthorized}
              />
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
