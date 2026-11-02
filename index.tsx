/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { HeadingTertiary } from "@components/Heading";
import SettingsPlugin from "@plugins/_core/settings";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { MediaEngineStore, Menu, Select, useStateFromStores } from "@webpack/common";
import type { ReactElement } from "react";

const AudioActions = findByPropsLazy("toggleSelfDeaf", "toggleSelfMute");
const LayoutTypes = findByPropsLazy("SECTION", "SIDEBAR_ITEM", "PANEL", "CUSTOM");

const settings = definePluginSettings({
    restoreOnReconnect: {
        type: OptionType.BOOLEAN,
        description: "Undeafen / unmute when the device is reconnected, if this plugin was what deafened / muted you",
        default: true
    },
    inputPicker: {
        type: OptionType.COMPONENT,
        component: () => <DevicePicker kind="input" />
    },
    outputPicker: {
        type: OptionType.COMPONENT,
        component: () => <DevicePicker kind="output" />
    },
    resetDevices: {
        type: OptionType.COMPONENT,
        component: () => (
            <Button variant="dangerPrimary" onClick={resetDeviceSelections}>
                Reset Device Selections
            </Button>
        )
    },
    outputDeviceId: {
        type: OptionType.CUSTOM,
        default: null as string | null
    },
    // Names are remembered so the device can still be shown (and unchecked) while it's unplugged
    outputDeviceName: {
        type: OptionType.CUSTOM,
        default: null as string | null
    },
    inputDeviceId: {
        type: OptionType.CUSTOM,
        default: null as string | null
    },
    inputDeviceName: {
        type: OptionType.CUSTOM,
        default: null as string | null
    }
});

type DeviceKind = "output" | "input";

const Kinds = {
    output: {
        idKey: "outputDeviceId",
        nameKey: "outputDeviceName",
        menuGroup: "audiooutput",
        label: "Auto-Deafen When Disconnected",
        getDevices: () => MediaEngineStore.getOutputDevices()
    },
    input: {
        idKey: "inputDeviceId",
        nameKey: "inputDeviceName",
        menuGroup: "audioinput",
        label: "Auto-Mute When Disconnected",
        getDevices: () => MediaEngineStore.getInputDevices()
    }
} as const;

interface DeviceOption {
    id: string;
    name: string;
    connected: boolean;
}

function isConnected(kind: DeviceKind, deviceId: string) {
    const device = Kinds[kind].getDevices()[deviceId];
    return device != null && !device.disabled;
}

function getDeviceOptions(kind: DeviceKind): DeviceOption[] {
    const { idKey, nameKey, getDevices } = Kinds[kind];
    const deviceId = settings.store[idKey];

    // "default" is Discord's "Windows Default" pseudo-device, which never disconnects
    const options: DeviceOption[] = Object.values(getDevices())
        .filter(d => d.id !== "default" && d.index !== -1)
        .map(d => ({ id: d.id, name: d.name, connected: !d.disabled }));

    if (deviceId && !options.some(d => d.id === deviceId))
        options.push({ id: deviceId, name: settings.store[nameKey] ?? "Unknown device", connected: false });

    return options;
}

function getLabel(device: DeviceOption) {
    return device.connected ? device.name : `${device.name} (disconnected)`;
}

// Only connected <-> disconnected transitions act. Checking "is it missing right now" instead
// would re-deafen you every time the store updates after you manually undeafen.
const wasConnected: Record<DeviceKind, boolean> = { output: false, input: false };
// Whether the current deafen / mute is ours, so reconnecting never undoes one you did yourself
const actedByUs: Record<DeviceKind, boolean> = { output: false, input: false };

function syncConnectedState(kind: DeviceKind) {
    const deviceId = settings.store[Kinds[kind].idKey];
    wasConnected[kind] = deviceId != null && isConnected(kind, deviceId);
    actedByUs[kind] = false;
}

// Only one device per kind can be watched, so picking a new one replaces the old one
function setWatchedDevice(kind: DeviceKind, device: DeviceOption | null) {
    const { idKey, nameKey } = Kinds[kind];

    settings.store[idKey] = device?.id ?? null;
    settings.store[nameKey] = device?.name ?? null;

    syncConnectedState(kind);
}

function resetDeviceSelections() {
    setWatchedDevice("output", null);
    setWatchedDevice("input", null);
}

/** Returns whether the device went from connected to disconnected (true), the reverse (false), or neither (null) */
function checkTransition(kind: DeviceKind): boolean | null {
    const { idKey, getDevices } = Kinds[kind];
    const deviceId = settings.store[idKey];
    if (!deviceId) return null;

    // An empty list means devices haven't been enumerated yet, not that everything was unplugged
    if (Object.keys(getDevices()).length === 0) return null;

    const connected = isConnected(kind, deviceId);
    if (connected === wasConnected[kind]) return null;

    wasConnected[kind] = connected;
    return !connected;
}

function onMediaEngineChange() {
    // You undid it yourself, so it's no longer ours to undo on reconnect
    if (actedByUs.output && !MediaEngineStore.isSelfDeaf()) actedByUs.output = false;
    if (actedByUs.input && !MediaEngineStore.isSelfMute()) actedByUs.input = false;

    // Both are read before acting: the toggles below update this store, which re-enters this listener
    const outputLost = checkTransition("output");
    const inputLost = checkTransition("input");
    const { restoreOnReconnect } = settings.store;

    if (outputLost === true && !MediaEngineStore.isSelfDeaf()) {
        actedByUs.output = true;
        AudioActions.toggleSelfDeaf();
    } else if (outputLost === false && restoreOnReconnect && actedByUs.output && MediaEngineStore.isSelfDeaf()) {
        actedByUs.output = false;
        AudioActions.toggleSelfDeaf();
    }

    // Deafening already mutes you, and toggling mute while deafened would undeafen you
    if (MediaEngineStore.isSelfDeaf() || outputLost === true) return;

    if (inputLost === true && !MediaEngineStore.isSelfMute()) {
        actedByUs.input = true;
        AudioActions.toggleSelfMute();
    } else if (inputLost === false && restoreOnReconnect && actedByUs.input && MediaEngineStore.isSelfMute()) {
        actedByUs.input = false;
        AudioActions.toggleSelfMute();
    }
}

function DevicePicker({ kind }: { kind: DeviceKind; }) {
    const { idKey, label, getDevices } = Kinds[kind];
    const deviceId = settings.use([idKey])[idKey];
    // Re-render when devices are plugged in or unplugged while this is open
    useStateFromStores([MediaEngineStore], getDevices);

    const devices = getDeviceOptions(kind);
    const options = [
        { label: "None", value: null },
        ...devices.map(d => ({ label: getLabel(d), value: d.id }))
    ];

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <HeadingTertiary>{label}</HeadingTertiary>
            <Select
                options={options}
                closeOnSelect={true}
                select={(id: string | null) => setWatchedDevice(kind, devices.find(d => d.id === id) ?? null)}
                isSelected={(id: string | null) => id === deviceId}
                serialize={String}
            />
        </div>
    );
}

// Mirrors the Microphone / Speaker columns above it on the Voice settings page
function VoiceSettingsSection() {
    return (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <DevicePicker kind="input" />
            <DevicePicker kind="output" />
        </div>
    );
}

function containsDevices(element: any, menuGroup: string): boolean {
    if (element == null || typeof element !== "object") return false;
    if (Array.isArray(element)) return element.some(e => containsDevices(e, menuGroup));

    const { id, group, children } = element.props ?? {};
    if ([id, group].some(v => typeof v === "string" && v.includes(menuGroup))) return true;

    return containsDevices(children, menuGroup);
}

const audioDeviceContextPatch: NavContextMenuPatchCallback = children => {
    // Called unconditionally, before any early return, to keep hook order stable
    const store = settings.use(["outputDeviceId", "inputDeviceId"]);

    // The deafen button's menu lists output devices and the mute button's lists input devices
    for (const kind of ["output", "input"] as const) {
        const { idKey, menuGroup, label } = Kinds[kind];

        const index = children.findIndex(c => containsDevices(c, menuGroup));
        if (index === -1) continue;

        const items: ReactElement[] = getDeviceOptions(kind).map(device => (
            <Menu.MenuCheckboxItem
                key={device.id}
                id={`vc-auto-deafen-${kind}-${device.id}`}
                label={getLabel(device)}
                checked={device.id === store[idKey]}
                action={() => setWatchedDevice(kind, device.id === store[idKey] ? null : device)}
            />
        ));

        children.splice(index + 1, 0,
            <Menu.MenuGroup>
                <Menu.MenuItem id={`vc-auto-deafen-${kind}`} label={label}>
                    {items}
                </Menu.MenuItem>
            </Menu.MenuGroup>
        );
    }
};

// Discord's settings pages are a tree of layout nodes, and the core Settings plugin already
// intercepts every node's buildLayout(). Wrapping it lets us add a node to the Voice page without
// a second patch on the same code. We look for the device dropdowns by key since that's the
// only stable thing about them.
const DEVICE_NODE_KEY = /(input|output)_?device/i;
const VOICE_NODE_KEY = "vc_auto_deafen_voice_settings";

type BuildLayout = typeof SettingsPlugin.buildLayout;
let originalBuildLayout: BuildLayout | null = null;

function injectVoiceSettings(layout: ReturnType<BuildLayout>) {
    if (!Array.isArray(layout) || layout.some(n => n?.key === VOICE_NODE_KEY)) return layout;

    const lastDeviceIndex = layout.findLastIndex(n => typeof n?.key === "string" && DEVICE_NODE_KEY.test(n.key));
    if (lastDeviceIndex === -1) return layout;

    layout.splice(lastDeviceIndex + 1, 0, {
        type: LayoutTypes.CUSTOM,
        key: VOICE_NODE_KEY,
        Component: VoiceSettingsSection,
        useSearchTerms: () => ["Auto-Deafen", "Auto-Mute"]
    } as ReturnType<BuildLayout>[number]);

    return layout;
}

export default definePlugin({
    name: "Auto Deafen & Mute",
    description: "Automatically deafens/mutes you when a chosen output/input device is connected or disconnected. Pick the either through the plugin settings page, the voice and video page in discord settings, or through right clicking the deafen or mute icons in the bottom left.",
    authors: [{ name: "Shadow_Bullet25", id: 626769346647162912n }],
    settings,

    contextMenus: {
        "audio-device-context": audioDeviceContextPatch
    },

    start() {
        syncConnectedState("output");
        syncConnectedState("input");
        MediaEngineStore.addChangeListener(onMediaEngineChange);

        const original = originalBuildLayout = SettingsPlugin.buildLayout;
        SettingsPlugin.buildLayout = function (this: typeof SettingsPlugin, builder) {
            return injectVoiceSettings(original.call(this, builder));
        };
    },

    stop() {
        MediaEngineStore.removeChangeListener(onMediaEngineChange);

        if (originalBuildLayout) SettingsPlugin.buildLayout = originalBuildLayout;
        originalBuildLayout = null;
    }
});
