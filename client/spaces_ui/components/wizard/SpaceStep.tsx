import { Button, Input } from "@silverbulletmd/silverbullet/ui";
import { FolderPicker } from "../../FolderPicker.tsx";
import { FieldErrors } from "../../space_fields.tsx";
import type { FieldError } from "../../types.ts";
import { defaultFolder, parentDir, type SpaceValues } from "../../wizard.ts";

export function SpaceStep({
  values,
  root,
  onNameInput,
  primaryUrl,
  onPrimaryUrlChange,
  onHostChange,
  onFolderChange,
  errors,
  busy,
  onBack,
  onSubmit,
}: {
  values: SpaceValues;
  /** The server's absolute data root, used for the folder placeholder. */
  root: string;
  onNameInput: (name: string) => void;
  primaryUrl: string;
  onPrimaryUrlChange: (value: string) => void;
  onHostChange: (value: string) => void;
  onFolderChange: (folder: string) => void;
  errors: FieldError[];
  busy: boolean;
  onBack: () => void;
  onSubmit: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <h1>Create your first space</h1>
      <p class="sb-help-text">Step 2 of 2</p>
      <FieldErrors errors={errors} />
      <label for="setup-space-name">Name</label>
      <Input
        id="setup-space-name"
        value={values.name}
        onInput={(e) => onNameInput(e.currentTarget.value)}
      />
      <label for="setup-primary-url">Primary URL</label>
      <Input
        id="setup-primary-url"
        type="url"
        required
        value={primaryUrl}
        onInput={(e) => onPrimaryUrlChange(e.currentTarget.value)}
      />
      <p class="sb-help-text">
        Confirm the public origin for server management and sign-in. The current
        browser origin is suggested. Spaces must use separate hostnames.
      </p>
      <label for="setup-host">Space hostname</label>
      <Input
        id="setup-host"
        required
        value={values.host ?? ""}
        placeholder="notes.example.com"
        onInput={(e) => onHostChange(e.currentTarget.value)}
      />
      <p class="sb-help-text">
        Configure this hostname to reach this server. It must differ from the
        primary URL hostname; do not include a scheme or path.
      </p>
      <label for="setup-folder">Folder</label>
      <FolderPicker
        id="setup-folder"
        value={values.folder}
        onChange={onFolderChange}
        apiBase="/.setup/api"
        placeholder={defaultFolder(root, values.name)}
        browseStart={parentDir(values.folder) || "/"}
      />
      <div class="row">
        <Button onClick={onBack}>Back</Button>
        <Button type="submit" variant="primary" disabled={busy}>
          Finish setup
        </Button>
      </div>
    </form>
  );
}
