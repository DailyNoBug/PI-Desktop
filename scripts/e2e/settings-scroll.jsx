// Mounted production SettingsPage; only the preload boundary uses fixture data.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { SettingsPage } from "../../apps/desktop/src/features/settings/SettingsPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const destinations = ["A", "B"].map((id) => ({
  ref: `fixture:${id}`, pluginId: "fixture", label: `Themes ${id}`, keywords: [],
  description: "Fixture theme collection", themes: Array.from({ length: 12 }, (_, index) => ({
    themeId: `plugin:fixture:${id}${index}`, label: `Theme ${index}`, description: "Preview",
    previewUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", blur: 6,
  })),
}));
let settings = { defaultMode: "agent", theme: "light", language: "en", enterToSend: true };
window.piDesktop = {
  platform: "darwin", on: () => () => {},
  async invoke(channel, input) {
    let data;
    switch (channel) {
      case IPC.invoke.pluginScenicThemesDestinations: data = destinations; break;
      case IPC.invoke.settingsGet: data = settings; break;
      case IPC.invoke.settingsSet: settings = input; data = settings; break;
      case IPC.invoke.commandShellList: data = { choices: [], effective: null }; break;
      default: throw new Error(`Unexpected fixture IPC: ${channel}`);
    }
    return { ok: true, data };
  },
};
await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
useAppStore.setState({ settings, settingsTab: "ai", page: "settings" });
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(<SettingsPage />));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function assert(value, message) { if (!value) throw new Error(message); }
const pane = () => document.querySelector(".settings-content");
async function select(label) {
  const button = [...document.querySelectorAll(".settings-nav-item")]
    .find((node) => node.textContent.trim() === label);
  assert(button, `Missing destination: ${label}`);
  flushSync(() => button.click());
  await settle();
}
async function scroll() {
  pane().scrollTop = 220;
  await settle();
  assert(pane().scrollTop > 0, "Destination must be scrollable for this check");
  return pane().scrollTop;
}
window.settingsScrollProbe = async () => {
  await settle();
  const checks = [];
  for (const theme of ["light", "dark"]) {
    document.documentElement.dataset.theme = theme;
    await select("AI");
    const position = await scroll();
    await select("AI");
    assert(pane().scrollTop === position, "Re-selecting AI must retain scroll");
    flushSync(() => useAppStore.setState({ settings: { ...settings, enterToSend: false } }));
    await settle();
    assert(pane().scrollTop === position, "Settings updates must retain scroll");
    await select("Shortcuts");
    assert(pane().scrollTop === 0, "AI → Shortcuts must start at top");
    await scroll();
    await select("AI");
    assert(pane().scrollTop === 0, "Returning to AI must start at top");
    await scroll();
    await select("Themes A");
    assert(pane().scrollTop === 0, "Built-in → extension must start at top");
    const extensionPosition = await scroll();
    await select("Themes A");
    assert(pane().scrollTop === extensionPosition, "Re-selecting extension must retain scroll");
    await select("Themes B");
    assert(pane().scrollTop === 0, "Extension → extension must start at top");
    await scroll();
    await select("AI");
    assert(pane().scrollTop === 0, "Extension → unchanged built-in tab must start at top");
    await select("Themes A");
    await scroll();
    flushSync(() => useAppStore.getState().setSettingsTab("shortcuts"));
    assert(!document.querySelector(".plugin-scenic-theme-card"), "External tab change must leave the plugin");
    assert(document.querySelector(".settings-section-title")?.textContent?.includes("Shortcuts"), "Shortcuts must replace the plugin");
    assert(pane().scrollTop === 0, "External tab change must start at the top");
    await select("Themes A");
    await scroll();
    flushSync(() => {
      useAppStore.getState().setSettingsAnchor("settings.enterToSend");
      useAppStore.getState().setSettingsTab("ai");
    });
    assert(!document.querySelector(".plugin-scenic-theme-card"), "Search must leave the plugin destination");
    const fromPlugin = document.querySelector(".settings-anchor-flash");
    assert(fromPlugin && pane().scrollTop > 0, "Search from a plugin must be positioned before paint");
    const fromPluginBounds = fromPlugin.getBoundingClientRect();
    const fromPluginViewport = pane().getBoundingClientRect();
    assert(fromPluginBounds.top >= fromPluginViewport.top && fromPluginBounds.bottom <= fromPluginViewport.bottom,
      "Search from a plugin must show the target");
    // The same public store entry points used by SearchDialog.openSettingsHit.
    await select("Shortcuts");
    await scroll();
    flushSync(() => {
      useAppStore.getState().setSettingsAnchor("settings.enterToSend");
      useAppStore.getState().setSettingsTab("ai");
    });
    const target = document.querySelector(".settings-anchor-flash");
    assert(target && pane().scrollTop > 0, "Search anchor must be positioned before paint");
    const bounds = target.getBoundingClientRect();
    const viewport = pane().getBoundingClientRect();
    assert(bounds.top >= viewport.top && bounds.bottom <= viewport.bottom,
      "Search target must be visible");
    assert(useAppStore.getState().settingsAnchor === null, "Search anchor must be consumed");
    const anchoredPosition = pane().scrollTop;
    await settle();
    assert(pane().scrollTop === anchoredPosition, "Consuming anchor must not reset scroll");
    pane().scrollTop = 0;
    flushSync(() => useAppStore.getState().setSettingsAnchor("settings.enterToSend"));
    const withinTab = document.querySelector(".settings-anchor-flash");
    assert(withinTab && pane().scrollTop > 0, "Search within the active tab must be positioned before paint");
    await settle();
    assert(pane().scrollTop > 0, "Search within the active tab must still locate its row");
    checks.push({ theme, ok: true });
  }
  return { ok: true, checks };
};
