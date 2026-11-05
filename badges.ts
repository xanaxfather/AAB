/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface TierRequirement {
    progress_type?: number;
    threshold: number;
    unit?: string;
}

export interface BadgeTier {
    key: string;
    name?: string;
    rarity?: number;
    simple_icon_url?: string;
    simple_icon_raster_url?: string;
    complex_icon_static_url?: string;
    complex_icon_animated_url?: string;
    requirements?: TierRequirement[];
    owned: boolean;
    milestone_text?: string;
}

export interface BadgeProgress {
    progress_type?: number;
    current: number;
    floor?: number;
    threshold?: number;
    unit?: string;
    window?: unknown;
    progress_helper_text?: string;
}

export interface DirectoryBadge {
    /** A number for Discord badges, a string for ones added by BadgeAPI */
    badge_id: number | string;
    name: string;
    description?: string;
    rarity?: number;
    simple_icon_url?: string;
    simple_icon_raster_url?: string;
    complex_icon_static_url?: string;
    complex_icon_animated_url?: string;
    is_earnable: boolean;
    owned: boolean;
    hidden?: boolean;
    info_label?: string | null;
    current_tier?: string | null;
    next_tier?: string | null;
    tiers?: BadgeTier[];
    progress?: BadgeProgress[];
}

export interface BadgeChoice {
    hidden?: boolean;
    tier?: string;
}

/** Badges someone shared, in display order: badge id to tier index */
export type SharedBadges = Map<number, number>;

export const STAFF_BADGE_ID = 22;
const EARLY_SUPPORTER_BADGE_ID = 11;

export interface BadgeDetails {
    description?: string;
    info_label?: string | null;
}

// Discord only sends these to people who own the badge. Only text seen on a real holder belongs here, never invented wording.
const MISSING_DETAILS: Record<number, BadgeDetails> = {
    2: { description: "Unlocked by being a member of the Discord Partner Program.", info_label: "Community leader" },
    3: { description: "Unlocked by completing the Discord Moderator Program.", info_label: "Officially certified" },
    5: { description: "Unlocked by taking a HypeSquad house quiz and getting sorted into Bravery.", info_label: "First in, no hesitation" },
    6: { description: "Unlocked by taking a HypeSquad house quiz and getting sorted into Brilliance.", info_label: "Patience meets discipline" }
};

const LEARNABLE_BADGES = new Set<number | string>([2, 3, 4, 5, 6, 8, 9, 10, STAFF_BADGE_ID]);
export const isLearnableBadge = (badgeId: number | string) => LEARNABLE_BADGES.has(badgeId);

const OWNER_DESCRIPTIONS: Record<number, string> = {
    19: "Stream more hours to other users to level up this badge.",
    20: "Play more hours of detectable PC games with Discord open to level up this badge.",
    21: "Play more detectable PC games with Discord open to level up this badge."
};

const count = (amount: number, word: string) => `${amount.toLocaleString("en-US")} ${word}${amount === 1 ? "" : "s"}`;

// Discord's label formats, like "33 hours streamed to others". Nitro and Boosting show a real date instead.
const TIER_LABELS: Record<number, (amount: number) => string> = {
    17: amount => `${count(amount, "gift")} given`,
    18: amount => count(amount, "year"),
    19: amount => `${count(amount, "hour")} streamed to others`,
    20: amount => `${count(amount, "hour")} of games played`,
    21: amount => `${count(amount, "game")} played`
};

const MARKER = "hmb:";
const END = ".";
const TAG_OFFSET = 0xe0000;

const toTags = (text: string) => Array.from(text, c => String.fromCodePoint(c.charCodeAt(0) + TAG_OFFSET)).join("");
const fromTags = (text: string) => Array.from(text, c => String.fromCharCode((c.codePointAt(0) ?? TAG_OFFSET) - TAG_OFFSET)).join("");

const SHARE_REGEX = new RegExp(`${toTags(MARKER)}([\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}]*)${toTags(END)}`, "u");

// A tier missing an image keeps the badge's own, so a half-filled new badge still shows something
function tierIcons(tier: BadgeTier, badge: DirectoryBadge) {
    const simple = tier.simple_icon_url ?? tier.simple_icon_raster_url;
    return {
        rarity: tier.rarity ?? badge.rarity,
        simple_icon_url: simple ?? badge.simple_icon_url,
        simple_icon_raster_url: tier.simple_icon_raster_url ?? simple ?? badge.simple_icon_raster_url,
        complex_icon_static_url: tier.complex_icon_static_url ?? (simple ? undefined : badge.complex_icon_static_url),
        complex_icon_animated_url: tier.complex_icon_animated_url
    };
}

export const badgeIcon = (badge: DirectoryBadge) =>
    badge.simple_icon_raster_url ?? badge.simple_icon_url ?? badge.complex_icon_static_url;

/** Someone else's copy of a badge built from yours, for badges they share but Discord doesn't list for them. Keeps the art and tiers, drops your dates and counts. */
export function asTemplate(badge: DirectoryBadge): DirectoryBadge {
    return {
        badge_id: badge.badge_id,
        name: badge.name,
        description: badge.description,
        rarity: badge.rarity,
        simple_icon_url: badge.simple_icon_url,
        simple_icon_raster_url: badge.simple_icon_raster_url,
        complex_icon_static_url: badge.complex_icon_static_url,
        complex_icon_animated_url: badge.complex_icon_animated_url,
        is_earnable: badge.is_earnable,
        owned: false,
        hidden: false,
        tiers: badge.tiers?.map(tier => ({ ...tier, owned: false }))
    };
}

function progressToward(badge: DirectoryBadge, tier: BadgeTier, next: BadgeTier): BadgeProgress[] {
    const floor = tier.requirements?.[0]?.threshold ?? 0;
    const requirement = next.requirements?.[0];
    const threshold = requirement?.threshold ?? floor;
    const remaining = threshold - floor;
    const unit = requirement?.unit || next.milestone_text?.replace(/[\d,+\s]/g, "") || "";
    const suffix = badge.progress?.[0]?.progress_helper_text?.match(/\bmore \S+( .+)$/)?.[1] ?? "";

    return [{
        progress_type: requirement?.progress_type,
        current: floor,
        floor,
        threshold,
        unit,
        window: null,
        progress_helper_text: `${remaining.toLocaleString("en-US")} more ${remaining === 1 ? unit.replace(/s$/, "") : unit}${suffix}`
    }];
}

/** Early Supporter's SVG has more empty space around it than its PNG and every other badge, so it looks small in badge grids */
export function withBadgeDetails(badge: DirectoryBadge, learned?: BadgeDetails): DirectoryBadge {
    const details = learned ?? MISSING_DETAILS[badge.badge_id];
    const filled = {
        ...badge,
        description: badge.description ?? details?.description,
        info_label: badge.info_label ?? details?.info_label
    };
    if (badge.badge_id !== EARLY_SUPPORTER_BADGE_ID || !badge.simple_icon_raster_url) return filled;

    return {
        ...filled,
        simple_icon_url: badge.simple_icon_raster_url,
        complex_icon_static_url: badge.complex_icon_static_url ?? badge.simple_icon_url
    };
}

/** Rewrites an unlock requirement like "Stream for 1 hour to unlock" for the tier you picked */
function tierDescription(badge: DirectoryBadge, tier: BadgeTier) {
    const from = badge.tiers?.find(t => t.key === badge.next_tier)?.requirements?.[0];
    const to = tier.requirements?.[0];
    if (badge.owned || !badge.description || !from || !to) return badge.description;

    const singular = from.unit?.replace(/s$/, "");
    const unit = singular ? `( ${singular}s?)?` : "()";
    return badge.description.replace(new RegExp(`\\b${from.threshold}${unit}\\b`), (_, hasUnit) => {
        const amount = to.threshold.toLocaleString("en-US");
        return hasUnit ? `${amount} ${to.threshold === 1 ? singular : to.unit}` : amount;
    });
}

function tierLabel(badge: DirectoryBadge, tier: BadgeTier) {
    const threshold = tier.requirements?.[0]?.threshold;
    const label = threshold != null ? TIER_LABELS[badge.badge_id]?.(threshold) : undefined;
    return label ?? badge.info_label;
}

/** How your own badge looks after your choices. Every badge counts as owned so Discord's UI lists and unlocks it. */
export function applyChoice(rawBadge: DirectoryBadge, choice?: BadgeChoice, learned?: BadgeDetails): DirectoryBadge {
    const badge = withBadgeDetails(rawBadge, learned);
    const hidden = choice?.hidden ?? (badge.owned ? badge.hidden ?? false : true);
    const result: DirectoryBadge = {
        ...badge,
        owned: true,
        hidden,
        tiers: badge.tiers?.map(tier => ({ ...tier, owned: true }))
    };
    if (!badge.tiers?.length) return result;

    const key = choice?.tier ?? badge.current_tier;
    const index = Math.max(badge.tiers.findIndex(tier => tier.key === key), 0);
    const tier = badge.tiers[index];
    const next = badge.tiers[index + 1];
    const isRealTier = badge.owned && tier.key === badge.current_tier;

    return {
        ...result,
        ...tierIcons(tier, badge),
        // Shown badges read like a real owner's, hidden ones you haven't earned show what it takes to unlock them
        description: hidden ? tierDescription(badge, tier) : badge.owned ? badge.description : OWNER_DESCRIPTIONS[badge.badge_id] ?? tierDescription(badge, tier),
        info_label: isRealTier ? badge.info_label : tierLabel(badge, tier),
        current_tier: tier.key,
        next_tier: next?.key ?? null,
        progress: isRealTier ? badge.progress : next && progressToward(badge, tier, next)
    };
}

/** How someone else's badge looks after what they shared. A missing tier index means they don't show it. */
export function applyShared(rawBadge: DirectoryBadge, tierIndex?: number, learned?: BadgeDetails): DirectoryBadge {
    const badge = withBadgeDetails(rawBadge, learned);
    if (tierIndex == null) return { ...badge, owned: false, hidden: false };

    const tier = badge.tiers?.[tierIndex] ?? badge.tiers?.[0];
    if (!badge.tiers || !tier) return { ...badge, owned: true, hidden: false };

    const index = badge.tiers.indexOf(tier);
    return {
        ...badge,
        ...tierIcons(tier, badge),
        description: OWNER_DESCRIPTIONS[badge.badge_id] ?? badge.description,
        info_label: tierLabel(badge, tier),
        owned: true,
        hidden: false,
        current_tier: tier.key,
        next_tier: null,
        progress: undefined,
        tiers: badge.tiers.map((t, i) => ({ ...t, owned: i <= index }))
    };
}

export function encodeShare(badges: Array<{ id: number; tierIndex: number; }>) {
    const body = badges
        .filter(({ id, tierIndex }) => id < 36 && tierIndex < 36)
        .map(({ id, tierIndex }) => id.toString(36) + tierIndex.toString(36))
        .join("");

    return toTags(MARKER + body + END);
}

export function decodeShare(bio?: string | null): SharedBadges | null {
    const match = bio?.match(SHARE_REGEX);
    if (!match) return null;

    const body = fromTags(match[1]);
    const shared: SharedBadges = new Map();
    for (let i = 0; i + 1 < body.length; i += 2) {
        const id = parseInt(body[i], 36);
        if (id === STAFF_BADGE_ID) continue;
        shared.set(id, parseInt(body[i + 1], 36));
    }

    return shared;
}

export function stripShare(bio: string) {
    return bio.replace(SHARE_REGEX, "");
}
