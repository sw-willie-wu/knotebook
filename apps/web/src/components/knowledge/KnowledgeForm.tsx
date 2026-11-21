import { useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { BlockNoteEditor } from "@blocknote/core";
import { KNOWLEDGE_EVIDENCE, readKnowledgeInfo, type KnowledgeDraft, type KnowledgeEntry, type KnowledgeEvidence, type KnowledgeStatus } from "@knotebook/shared";
import { Button } from "@/components/ui/button";
import { DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { isKnowledgeEligible, removeKnowledge, saveKnowledge, todayLocalDate } from "./commands";
import { draftForSave, draftOf, fieldOfError, singleLine, tooLongLength, type FormField } from "./form-state";
import { KnowledgeRefSourceContext, localKnowledgeRefSource } from "./ref-source";
import { SupersedePicker } from "./SupersedePicker";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple (repo convention)
type AnyEditor = BlockNoteEditor<any, any, any>;

export interface KnowledgeFormProps {
  editor: AnyEditor;
  blockId: string;
  /** Read when needed, not at render: the form must see knowledge a collaborator adds while it is open. */
  getEntries: () => readonly KnowledgeEntry[];
  noteId: string | null;
  /** On a phone the form lives in a dialog and its title is the dialog's. */
  phone: boolean;
  close: () => void;
}

const STATUS_VALUES: readonly KnowledgeStatus[] = ["", "unverified", "outdated"];
const FIELD_LABEL = "text-xs text-muted-foreground";
const ERROR_TEXT = "mt-1 text-xs text-red-700 dark:text-red-300";

export function KnowledgeForm({ editor, blockId, getEntries, noteId, phone, close }: KnowledgeFormProps) {
  const { t } = useTranslation();
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  // Taken once: the form edits against what the heading was when it opened, so a collaborator's later change to another field survives.
  const [base] = useState(() => readKnowledgeInfo(editor.getBlock(blockId)?.props as Record<string, unknown> | undefined));
  const [draft, setDraft] = useState<KnowledgeDraft>(() => draftOf(base));
  const [touched, setTouched] = useState<ReadonlySet<keyof KnowledgeDraft>>(() => new Set());
  const [failure, setFailure] = useState<{ field: FormField; message: string } | null>(null);
  const dateRef = useRef<HTMLInputElement | null>(null);
  const radioRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const edit = <K extends keyof KnowledgeDraft>(field: K, value: KnowledgeDraft[K]) => {
    setDraft((d) => ({ ...d, [field]: value }));
    setTouched((s) => new Set(s).add(field));
    setFailure((f) => (f && (f.field === field || f.field === "form") ? null : f));
  };

  // Whether the heading still carries knowledge info; a collaborator may remove it while the form is open.
  const [hasInfo, setHasInfo] = useState(true);
  const gone = () => {
    toast({ title: t("knowledge.form.error.notEligible") });
    close();
  };
  const goneRef = useRef(gone);
  goneRef.current = gone;
  useEffect(() => {
    // A collaborator turning the heading into something else, moving it into a column or deleting it must not leave a form that would write elsewhere.
    const unsubscribe = editor.onChange(() => {
      if (!isKnowledgeEligible(editor, blockId)) goneRef.current();
      else setHasInfo(readKnowledgeInfo(editor.getBlock(blockId)?.props as Record<string, unknown> | undefined) !== null);
    });
    return typeof unsubscribe === "function" ? unsubscribe : undefined;
  }, [editor, blockId]);

  const localSource = useMemo(() => localKnowledgeRefSource(getEntries, noteId), [getEntries, noteId]);
  const remoteSource = useContext(KnowledgeRefSourceContext);

  const messageOf = (field: FormField, error: string): string => {
    if (error === "whenTooLong" || error === "conclusionTooLong") {
      const over = tooLongLength(error === "whenTooLong" ? "when" : "conclusion", draft, new Set(touched).add(field as keyof KnowledgeDraft));
      return t("knowledge.form.error.tooLong", { max: over?.max, n: over?.n });
    }
    return t(`knowledge.form.error.${error}`);
  };

  const save = () => {
    // A half-typed date reads as "" and would silently clear the stored one.
    if (dateRef.current?.validity.badInput) {
      setFailure({ field: "verified", message: t("knowledge.form.error.verifiedIncomplete") });
      dateRef.current.focus();
      return;
    }
    const result = saveKnowledge(editor, blockId, base, draftForSave(draft), noteId, touched);
    if (result.ok) {
      close();
      return;
    }
    if (result.reason === "notEligible") {
      gone();
      return;
    }
    const field = fieldOfError(result.reason);
    setFailure({ field, message: messageOf(field, result.reason) });
    const target = field === "form" ? "when" : field === "status" ? "status-0" : field;
    document.getElementById(id(target))?.focus();
  };

  const remove = () => {
    if (!removeKnowledge(editor, blockId)) toast({ title: t("knowledge.form.error.notEligible") });
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.getAttribute("role") === "combobox") return;
    // The Enter that confirms an input-method composition must not save; some browsers report it only through keyCode 229.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    save();
  };

  const whenOver = tooLongLength("when", draft, touched);
  const conclusionOver = tooLongLength("conclusion", draft, touched);
  const fieldError = (field: FormField): string | null => {
    if (field === "when" && whenOver) return t("knowledge.form.error.tooLong", whenOver);
    if (field === "conclusion" && conclusionOver) return t("knowledge.form.error.tooLong", conclusionOver);
    return failure?.field === field ? failure.message : null;
  };
  const errorProps = (field: FormField) => {
    const message = fieldError(field);
    return { message, invalid: message !== null, describedBy: message ? id(`${field}-error`) : undefined };
  };
  const textField = (field: "when" | "conclusion", autoFocus: boolean) => {
    const e = errorProps(field);
    return (
      <div className="mt-2">
        <label htmlFor={id(field)} id={id(`${field}-label`)} className={cn(FIELD_LABEL, "mb-0.5 block")}>
          {t(`knowledge.field.${field}`)}
        </label>
        <Input
          id={id(field)}
          data-kb-autofocus={autoFocus ? "" : undefined}
          value={singleLine(draft[field])}
          aria-invalid={e.invalid || undefined}
          aria-describedby={e.describedBy}
          onChange={(ev) => edit(field, ev.target.value)}
        />
        {e.message && <p id={e.describedBy} className={ERROR_TEXT}>{e.message}</p>}
      </div>
    );
  };

  const evidenceOptions = [{ value: "", label: t("knowledge.evidence.unconfirmed") }, ...KNOWLEDGE_EVIDENCE.map((v) => ({ value: v, label: t(`knowledge.evidence.${v}`) }))];
  const statusError = errorProps("supersededBy");
  const verifiedError = errorProps("verified");
  const title = t("knowledge.form.title");

  return (
    <form noValidate onSubmit={(e) => e.preventDefault()} onKeyDown={onKeyDown} data-kb-knowledge-form="" className="text-left text-sm text-popover-foreground">
      <div className={cn("flex items-baseline justify-between gap-2", phone && "pr-7")}>
        {phone ? <DialogTitle className="text-sm font-semibold">{title}</DialogTitle> : <h2 className="m-0 text-sm font-semibold">{title}</h2>}
        {base && hasInfo && (
          <button type="button" onClick={remove} className="rounded-sm text-xs text-red-700 underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-red-300">
            {t("knowledge.form.remove")}
          </button>
        )}
      </div>

      {textField("when", true)}
      {textField("conclusion", false)}

      <div className="mt-2">
        <label id={id("evidence-label")} htmlFor={id("evidence")} className={cn(FIELD_LABEL, "mb-0.5 block")}>
          {t("knowledge.field.evidence")}
        </label>
        <Select
          id={id("evidence")}
          variant="field"
          className="w-full"
          aria-labelledby={id("evidence-label")}
          value={draft.evidence}
          options={evidenceOptions}
          onValueChange={(v) => edit("evidence", v as KnowledgeEvidence)}
        />
      </div>

      <div className="mt-2">
        <span id={id("status-label")} className={cn(FIELD_LABEL, "mb-0.5 block")}>
          {t("knowledge.field.status")}
        </span>
        <div
          role="radiogroup"
          aria-labelledby={id("status-label")}
          className="flex h-8 overflow-hidden rounded-md border border-input pointer-coarse:h-11"
          onKeyDown={(event) => {
            const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
            if (step === 0) return;
            event.preventDefault();
            const next = (STATUS_VALUES.indexOf(draft.status) + step + STATUS_VALUES.length) % STATUS_VALUES.length;
            edit("status", STATUS_VALUES[next]!);
            radioRefs.current[next]?.focus();
          }}
        >
          {STATUS_VALUES.map((value, i) => {
            const checked = draft.status === value;
            return (
              <button
                key={value || "current"}
                ref={(el) => {
                  radioRefs.current[i] = el;
                }}
                id={id(`status-${i}`)}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                data-state={checked ? "on" : "off"}
                onClick={() => edit("status", value)}
                className={cn(
                  "flex-1 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  i > 0 && "border-l border-input",
                  !checked && "text-muted-foreground hover:bg-muted",
                  checked && value === "unverified" && "bg-amber-100 font-semibold text-amber-900 dark:bg-amber-400/15 dark:text-amber-200",
                  checked && value !== "unverified" && "bg-accent font-semibold text-accent-foreground",
                )}
              >
                {t(`knowledge.status.${value === "" ? "current" : value}`)}
              </button>
            );
          })}
        </div>
      </div>

      {draft.status === "outdated" && (
        <div className="mt-2">
          <span id={id("supersededBy-label")} className={cn(FIELD_LABEL, "mb-0.5 block")}>
            {t("knowledge.field.supersededBy")}
          </span>
          <SupersedePicker
            id={id("supersededBy")}
            labelledBy={id("supersededBy-label")}
            describedBy={statusError.describedBy}
            invalid={statusError.invalid}
            value={draft.supersededBy}
            source={localSource}
            remote={remoteSource}
            exclude={(c) => base !== null && c.ref === base.id}
            onChange={(ref) => edit("supersededBy", ref)}
          />
          {statusError.message && <p id={statusError.describedBy} className={ERROR_TEXT}>{statusError.message}</p>}
        </div>
      )}

      <div className="mt-2">
        <label htmlFor={id("verified")} className={cn(FIELD_LABEL, "mb-0.5 block")}>
          {t("knowledge.field.verified")}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id={id("verified")}
            ref={dateRef}
            type="date"
            className="min-w-0 flex-1 dark:[color-scheme:dark]"
            value={draft.verified}
            aria-invalid={verifiedError.invalid || undefined}
            aria-describedby={verifiedError.describedBy}
            onChange={(ev) => edit("verified", ev.target.value)}
          />
          <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => edit("verified", todayLocalDate())}>
            {t("knowledge.form.markToday")}
          </Button>
        </div>
        {verifiedError.message && <p id={verifiedError.describedBy} className={ERROR_TEXT}>{verifiedError.message}</p>}
      </div>

      {failure?.field === "form" && (
        <p role="alert" className={ERROR_TEXT}>
          {failure.message}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        {!phone && <span className="text-xs text-muted-foreground">{t("knowledge.form.escHint")}</span>}
        <div className={cn("flex gap-2", phone && "w-full")}>
          <Button type="button" variant="outline" size="sm" className={cn(phone && "h-11 flex-1 text-[15px]")} onClick={close}>
            {t("knowledge.form.cancel")}
          </Button>
          <Button type="button" variant="brandDeep" size="sm" className={cn(phone && "h-11 flex-1 text-[15px]")} onClick={save}>
            {t("knowledge.form.save")}
          </Button>
        </div>
      </div>
    </form>
  );
}
