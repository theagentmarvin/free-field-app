// src/components/UploadButton.tsx
//
// Triggers a multi-select .ifc file picker and forwards the chosen
// files to the parent for sequential loading. The actual pipeline
// orchestration lives in <IfcSidebarBlock>; this component is the
// trigger and the styled button only.
//
// Visual: a plus icon + (optional) "Upload" label. The icon-only
// variant is what sits in the IFC block header; a full-width "Browse"
// variant is what the <EmptyViewerDropzone> uses.

import { ChangeEvent, ReactNode, useCallback, useRef } from "react";

export interface UploadButtonProps {
  onFiles: (files: File[]) => void | Promise<void>;
  busy?: boolean;
  /** "icon" → small + in the block header; "full" → button with label. */
  variant?: "icon" | "full";
  label?: string;
  accept?: string;
  /** Force the button into a disabled state with a tooltip. Overrides `busy`. */
  disabled?: boolean;
  /** Tooltip shown when `disabled` is true. Falls back to `label` if unset. */
  disabledReason?: string;
}

const iconButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  borderRadius: 4,
  border: "1px solid var(--ff-border)",
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  cursor: "pointer",
  flexShrink: 0,
  padding: 0,
};

const fullButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  padding: "8px 16px",
  borderRadius: 4,
  border: "1px solid var(--ff-blue-active)",
  background: "var(--ff-blue-active)",
  color: "#ffffff",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
};

function PlusIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export default function UploadButton({
  onFiles,
  busy = false,
  variant = "icon",
  label = "Upload IFC",
  accept = ".ifc,application/x-step",
  disabled = false,
  disabledReason,
}: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const list = e.target.files;
      if (!list || list.length === 0) return;
      const files = Array.from(list);
      // Reset the input so the same file can be re-selected (e.g.
      // for "Replace version" via the kebab menu).
      e.target.value = "";
      await onFiles(files);
    },
    [onFiles],
  );

  const handleClick = useCallback(() => {
    if (disabled) return;
    inputRef.current?.click();
  }, [disabled]);

  const isDisabled = disabled || busy;
  const tooltip = isDisabled
    ? disabledReason ?? (busy ? "Uploading…" : label)
    : label;

  const baseStyle =
    variant === "icon" ? iconButtonStyle : fullButtonStyle;
  const finalStyle: React.CSSProperties = isDisabled
    ? {
        ...baseStyle,
        opacity: 0.5,
        cursor: "not-allowed",
      }
    : baseStyle;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        onChange={handleChange}
        disabled={isDisabled}
        style={{ display: "none" }}
        data-testid="upload-input"
      />
      <button
        type="button"
        onClick={handleClick}
        disabled={isDisabled}
        style={finalStyle}
        aria-label={label}
        aria-disabled={isDisabled}
        title={tooltip}
        data-testid={variant === "icon" ? "upload-button" : "browse-button"}
      >
        {variant === "icon" ? (
          <PlusIcon />
        ) : (
          <>
            <PlusIcon />
            <span>{busy ? "Uploading…" : label}</span>
          </>
        )}
      </button>
    </>
  );
}
