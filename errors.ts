/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { showToast } from "@webpack/common";

export const logger = new Logger("AAB");

export const ERRORS = {
    PATCH_MISSING: { code: "AAB-100", message: "Discord changed its badge code, so AAB can't change badges right now. Discord's normal badges are showing instead." },
    CATALOG_FETCH: { code: "AAB-101", message: "Couldn't load your badges from Discord. AAB will try again in a minute." },
    BADGE_RENDER: { code: "AAB-102", message: "A badge couldn't be customized, so Discord's own version is showing instead." },
    PROFILE_RENDER: { code: "AAB-103", message: "Couldn't customize a profile's badge row, so Discord's own badges are showing instead." },
    BADGE_IDS: { code: "AAB-104", message: "Discord changed how badges are named, so AAB can't change the badge row on profiles." },
    CHOICE_SAVE: { code: "AAB-105", message: "Couldn't save that badge change." },
    SHARE_PUBLISH: { code: "AAB-110", message: "Couldn't update your shared badge choices." },
    SHARE_TOO_LONG: { code: "AAB-111", message: "Your bio is too long to fit your shared badge choices." },
    SHARE_UNSUPPORTED: { code: "AAB-112", message: "Some of your badges are too new to share yet, so they were left out." }
} as const;

export type ErrorKey = keyof typeof ERRORS;

export interface ErrorEntry {
    code: string;
    message: string;
    detail: string;
    count: number;
    firstAt: number;
    lastAt: number;
}

const entries = new Map<string, ErrorEntry>();

// Error text only, never ids, names, bios or message content
function describe(error: unknown) {
    if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 200);
    return error == null ? "" : String(error).slice(0, 200);
}

/** Records a failure once per code with a toast, and counts repeats without spamming the user or the console */
export function report(key: ErrorKey, error?: unknown) {
    const { code, message } = ERRORS[key];
    const now = Date.now();
    const entry = entries.get(code);

    if (entry) {
        entry.count++;
        entry.lastAt = now;
        if (entry.count % 50 === 0) logger.warn(`${code} happened ${entry.count} times this session`);
        return;
    }

    entries.set(code, { code, message, detail: describe(error), count: 1, firstAt: now, lastAt: now });
    logger.error(`${code} ${message}`, error ?? "");
    // Toasts can't be shown while Discord is rendering, which is where most of these come from
    setTimeout(() => showToast({ text: `${message} (${code})`, variant: "critical" }));
}

/** Runs code that Discord calls while rendering, where a throw would crash the whole app */
export function guard<T>(key: ErrorKey, fallback: () => T, run: () => T): T {
    try {
        return run();
    } catch (e) {
        report(key, e);
        return fallback();
    }
}

export const getErrors = () => Array.from(entries.values());
