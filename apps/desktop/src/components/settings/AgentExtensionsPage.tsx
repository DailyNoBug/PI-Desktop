import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  TrustedExtensionDiagnostic,
  TrustedExtensionEntry,
  TrustedExtensionsListResult,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import {
  AgentCapabilityPage,
  CapabilityButton,
  CapabilityEmpty,
  CapabilityGroupHeader,
  CapabilityPanel,
  CapabilityRow,
  CapabilityRowMenu,
  CapabilityToggle,
  CapabilityToolbar,
  matchesCapabilitySearch,
  type CapabilityMenuItem,
} from "./AgentCapabilityLayout";
import { IconPlug, IconRefresh, IconPlus, IconTrash, IconShield } from "../icons";
import { cx } from "../ui";

const STATE_CLASS: Record<TrustedExtensionEntry["state"], string> = {
  disabled: "",
  loaded: "is-ready",
  error: "is-failed",
  missing: "is-failed",
};

function DiagnosticsList({ diagnostics }: { diagnostics: TrustedExtensionDiagnostic[] }) {
  const { t } = useTranslation();
  return (
    <ul className="agent-extension-diagnostics" aria-label={t("extensions.trusted.diagnostics")}>
      {diagnostics.map((diagnostic) => (
        <li
          key={`${diagnostic.kind}:${diagnostic.member ?? ""}`}
          className={cx(
            "agent-extension-diagnostic",
            (diagnostic.kind === "load_error" ||
              diagnostic.kind === "factory_error" ||
              diagnostic.kind === "handler_error" ||
              diagnostic.kind === "handler_timeout") &&
              "is-error",
          )}
        >
          <span className="agent-extension-diagnostic-kind">
            {t(`extensions.trusted.kinds.${diagnostic.kind}`)}
          </span>
          {diagnostic.member ? (
            <code className="agent-extension-diagnostic-member">{diagnostic.member}</code>
          ) : null}
          <span className="agent-extension-diagnostic-message" title={diagnostic.stack}>
            {diagnostic.message}
          </span>
          {diagnostic.count > 1 ? (
            <span className="agent-capability-badge">×{diagnostic.count}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function AgentExtensionsPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [result, setResult] = useState<TrustedExtensionsListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const load = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    try {
      setResult(await api.listTrustedExtensions());
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load("initial");
    return api.onExtensionsChanged(() => void load());
  }, [load]);

  const entries = useMemo(() => {
    const all = result?.entries ?? [];
    if (!search.trim()) return all;
    return all.filter((entry) =>
      matchesCapabilitySearch(search, entry.label, entry.entry, ...entry.toolNames, ...entry.commandNames),
    );
  }, [result, search]);

  const groups = useMemo(
    () => ({
      user: entries.filter((entry) => entry.source === "user"),
      project: entries.filter((entry) => entry.source === "project"),
      manual: entries.filter((entry) => entry.source === "manual"),
    }),
    [entries],
  );

  const toggle = async (entry: TrustedExtensionEntry) => {
    setBusyId(entry.id);
    try {
      await api.setTrustedExtensionEnabled(entry.id, !entry.enabled);
      showToast(
        t(entry.enabled ? "settings.capabilityDisabled" : "settings.capabilityEnabled", {
          name: entry.label,
        }),
        { variant: "success" },
      );
      if (!entry.enabled) showToast(t("extensions.trusted.loadsNextPrompt"));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const rescan = async () => {
    setRefreshing(true);
    try {
      setResult(await api.rescanTrustedExtensions());
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setRefreshing(false);
    }
  };

  const addPath = async () => {
    try {
      const picked = await api.addTrustedExtensionPath();
      if (!picked.canceled) setResult(picked);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  const remove = async (entry: TrustedExtensionEntry) => {
    try {
      await api.removeTrustedExtension(entry.id);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  const renderRow = (entry: TrustedExtensionEntry) => {
    const open = expanded.has(entry.id);
    const menuItems: CapabilityMenuItem[] = [
      {
        key: "remove",
        label: t("extensions.trusted.remove"),
        icon: <IconTrash size={14} />,
        danger: true,
        disabled: entry.enabled && !entry.missing,
        onSelect: () => void remove(entry),
      },
    ];
    const summary = [
      entry.toolNames.length
        ? t("extensions.trusted.toolCount", { count: entry.toolNames.length })
        : null,
      entry.commandNames.length
        ? t("extensions.trusted.commandCount", { count: entry.commandNames.length })
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <CapabilityRow
        key={entry.id}
        glyph={<IconPlug size={16} />}
        glyphState={entry.state === "error" || entry.state === "missing" ? "failed" : undefined}
        name={entry.label}
        badges={
          <span className={cx("agent-capability-badge", STATE_CLASS[entry.state])}>
            {t(`extensions.trusted.state.${entry.state}`)}
          </span>
        }
        command={entry.entry}
        description={summary || t("extensions.trusted.noRegistrations")}
        meta={
          entry.diagnostics.length ? (
            <>
              <button
                type="button"
                className="agent-extension-diagnostics-toggle"
                aria-expanded={open}
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(entry.id)) next.delete(entry.id);
                    else next.add(entry.id);
                    return next;
                  })
                }
              >
                {t("extensions.trusted.diagnosticCount", { count: entry.diagnostics.length })}
              </button>
              {open ? <DiagnosticsList diagnostics={entry.diagnostics} /> : null}
            </>
          ) : undefined
        }
        off={!entry.enabled}
        menuOpen={menuFor === entry.id}
        actions={
          <>
            <CapabilityToggle
              checked={entry.enabled}
              label={t("settings.toggleCapability", { name: entry.label })}
              disabled={entry.missing && !entry.enabled}
              busy={busyId === entry.id}
              onChange={() => void toggle(entry)}
            />
            <CapabilityRowMenu
              label={t("extensions.trusted.moreActions", { name: entry.label })}
              items={menuItems}
              open={menuFor === entry.id}
              onOpenChange={(next) => setMenuFor(next ? entry.id : null)}
            />
          </>
        }
      />
    );
  };

  const empty = !loading && entries.length === 0;

  return (
    <AgentCapabilityPage
      description={t("extensions.trusted.description")}
      className="agent-extensions-page"
      toolbar={
        <CapabilityToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("extensions.trusted.searchPlaceholder")}
          actions={
            <>
              <CapabilityButton onClick={() => void rescan()} busy={refreshing}>
                <IconRefresh size={14} />
                {t("extensions.trusted.rescan")}
              </CapabilityButton>
              <CapabilityButton variant="primary" onClick={() => void addPath()}>
                <IconPlus size={14} />
                {t("extensions.trusted.addPath")}
              </CapabilityButton>
            </>
          }
        />
      }
    >
      <p className="agent-extension-trust-notice" role="note">
        <IconShield size={14} aria-hidden="true" />
        <span>{t("extensions.trusted.trustNotice")}</span>
      </p>
      <CapabilityPanel
        loading={loading}
        refreshing={refreshing}
        loadingLabel={t("settings.loadingCapabilities")}
      >
        {empty ? (
          <CapabilityEmpty
            message={
              search.trim()
                ? t("settings.capabilityNoMatches")
                : t("extensions.trusted.empty")
            }
            hint={search.trim() ? undefined : result?.roots.user}
            icon={<IconPlug size={18} aria-hidden="true" />}
          />
        ) : (
          <>
            {groups.user.length ? (
              <>
                <CapabilityGroupHeader
                  label={t("extensions.trusted.userRoot")}
                  path={result?.roots.user ?? ""}
                  count={groups.user.length}
                />
                {groups.user.map(renderRow)}
              </>
            ) : null}
            {groups.project.length ? (
              <>
                <CapabilityGroupHeader
                  label={t("extensions.trusted.projectRoot")}
                  path={result?.roots.project ?? ""}
                  count={groups.project.length}
                />
                {groups.project.map(renderRow)}
              </>
            ) : null}
            {groups.manual.length ? (
              <>
                <CapabilityGroupHeader
                  label={t("extensions.trusted.manualRoot")}
                  path={result?.roots.manual.join(", ") ?? ""}
                  count={groups.manual.length}
                />
                {groups.manual.map(renderRow)}
              </>
            ) : null}
          </>
        )}
      </CapabilityPanel>
    </AgentCapabilityPage>
  );
}
