// @vitest-environment node
import { expect, it } from "vitest";
import { installSettingsStorageLifecycle, setTestLocation } from "../test-helpers/settings-node.ts";
import { createApplicationNavigationPreferences } from "./bootstrap-navigation-preferences.ts";
import { loadSettings, saveSettings } from "./settings.ts";

installSettingsStorageLifecycle();
it("shows Mini Me to an existing sidebar without rewriting pins and respects explicit removal", () => {
  setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
  saveSettings({
    ...loadSettings(),
    sidebarEntries: ["route:usage", "session:agent:main:kept"],
    sidebarMiniMeManaged: false,
  });
  const preferences = {
    get settings() {
      return loadSettings();
    },
    subscribe: () => () => {},
  };
  const navigation = createApplicationNavigationPreferences(preferences);
  expect(navigation.snapshot.sidebarEntries).toEqual([
    "route:mini-me",
    "route:usage",
    "session:agent:main:kept",
  ]);
  expect(loadSettings().sidebarEntries).toEqual(["route:usage", "session:agent:main:kept"]);
  navigation.update({ sidebarEntries: ["route:usage", "session:agent:main:kept"] });
  const fresh = createApplicationNavigationPreferences(preferences);
  expect(fresh.snapshot.sidebarEntries).toEqual(["route:usage", "session:agent:main:kept"]);
  expect(loadSettings().sidebarMiniMeManaged).toBe(true);
});
