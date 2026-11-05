/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings, migratePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { copyWithToast, fetchUserProfile } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { filters, findByCodeLazy, findByPropsLazy, findComponentByCodeLazy, findExportedComponentLazy, findStoreLazy, mapMangledModuleLazy } from "@webpack";
import { Clickable, Constants, RestAPI, SearchableSelect, Tooltip, UserProfileStore, UserStore, useStateFromStores } from "@webpack/common";
import type { ComponentType, KeyboardEvent, ReactNode } from "react";

import { applyChoice, applyShared, asTemplate, BadgeChoice, BadgeDetails, badgeIcon, BadgeTier, decodeShare, DirectoryBadge, encodeShare, isLearnableBadge, SharedBadges, STAFF_BADGE_ID, stripShare, withBadgeDetails } from "./badges";
import { ERRORS, getErrors, guard, logger, report } from "./errors";

const cl = classNameFactory("vc-hmb-");

// Name of the method our patch moves Discord's original getBadges() body into
const ORIGINAL_GET_BADGES = "vcAABOriginal";
const ORIGINAL_CATALOG = "vcAABCatalog";
const ORIGINAL_BADGE = "vcAABBadge";

const TITLE = "Profile Badges";
const DESCRIPTION = "Choose which badges you see on your own profile. Only you see this change unless you turn on sharing.";

const BIO_LIMIT = 190;
const PUBLISH_DELAY = 3000;
const CATALOG_RETRY_DELAY = 60_000;
const HEALTH_CHECK_DELAY = 15_000;
const SHARED_CACHE_LIMIT = 50;
const KNOWN_BADGE_COUNT = 22;

interface ProfileBadge {
    id: string;
    icon?: string;
    iconSrc?: string;
    description?: string;
}

interface DisplayProfile {
    userId?: string;
}

interface SectionProps {
    title?: ReactNode;
    description?: ReactNode;
    children?: ReactNode;
}

interface BadgeDetailProps {
    badge: DirectoryBadge;
    isViewingOtherUser?: boolean;
}

interface BadgeExperiment {
    getConfig(options: unknown): object;
    useConfig(options: unknown): object;
}

interface BadgeDirectoryStoreType {
    getBadges(userId?: string): DirectoryBadge[];
    getBadgeById(badgeId: number, userId?: string): DirectoryBadge | undefined;
    hasCatalogFor(userId: string): boolean;
    emitChange(): void;
    [ORIGINAL_CATALOG]?(userId?: string): DirectoryBadge[];
}

type NumberedBadge = DirectoryBadge & { badge_id: number; };

interface SharedCatalog {
    shared: SharedBadges;
    revision: number;
    sources: DirectoryBadge[];
    badges: NumberedBadge[];
    byId: Map<number, NumberedBadge>;
}

const BadgeDirectoryStore: BadgeDirectoryStoreType = findStoreLazy("BadgeDirectoryStore");
const fetchBadgeCatalog: (userId: string) => Promise<void> = findByCodeLazy('"BADGE_DIRECTORY_FETCH_START"');
const { openBadgeDirectoryModal } = findByPropsLazy("openBadgeDirectoryModal") as { openBadgeDirectoryModal(options: { viewingCurrentUserBadges: boolean; }): void; };
const BadgeIds = mapMangledModuleLazy("premium_tenure_1_month_v2:1,", {
    toBadgeId: filters.byCode("toUpperCase"),
    toLegacyId: filters.byCode(/\.get\(\i\)\?\?/)
}) as { toBadgeId(legacyId: string): number | undefined; toLegacyId(badgeId: number): string; };

const EyeIcon = findExportedComponentLazy("EyeIcon");
const EyeSlashIcon = findExportedComponentLazy("EyeSlashIcon");

// The section wrapper used by Settings > Profiles ("Profile Banner", "Profile Theme", ...)
const SettingsSection = findComponentByCodeLazy<SectionProps>('"data-migration-pending":!0,children:[', "forcedDivider:", "hasBackground:");

let revision = 0;
let ownBadgeCache = new WeakMap<DirectoryBadge, DirectoryBadge>();
let detailedBadgeCache = new WeakMap<DirectoryBadge, DirectoryBadge>();
const sharedByBio = new Map<string, SharedBadges | null>();
const sharedCatalogs = new Map<string, SharedCatalog>();
let catalogRequested = false;
let experimentForced = false;
let publishTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let healthTimer: ReturnType<typeof setTimeout> | undefined;

const settings = definePluginSettings({
    picker: {
        type: OptionType.COMPONENT,
        description: "Choose which badges are shown",
        component: () => <BadgeSelect />
    },
    shareSelections: {
        type: OptionType.BOOLEAN,
        description: "Let other people with this plugin see your badge choices. This saves an invisible code to your Discord bio, and turning it off removes the code.",
        default: false,
        onChange: () => schedulePublish()
    },
    seeShared: {
        type: OptionType.BOOLEAN,
        description: "Show badge choices shared by other people with this plugin.",
        default: true,
        onChange: () => refresh()
    },
    diagnostics: {
        type: OptionType.COMPONENT,
        description: "What's working, and any errors to report",
        component: () => <Diagnostics />
    },
    choices: {
        type: OptionType.CUSTOM,
        description: "Your visibility and tier choice per badge id",
        hidden: true,
        default: {} as Record<string, BadgeChoice>
    },
    order: {
        type: OptionType.CUSTOM,
        description: "Your badge ids in display order",
        hidden: true,
        default: [] as number[]
    },
    learnedDetails: {
        type: OptionType.CUSTOM,
        description: "Discord's own text for badges you don't own, seen on people who do",
        hidden: true,
        default: {} as Record<string, BadgeDetails>
    }
});

// settings.plain leaves out defaults for settings that were never saved, and these are read while Discord renders
function savedSettings() {
    const { choices, order, learnedDetails, seeShared } = settings.plain;
    return { choices: choices ?? {}, order: order ?? [], learnedDetails: learnedDetails ?? {}, seeShared: seeShared ?? true };
}

const isDiscordBadge = (badge: DirectoryBadge | undefined): badge is NumberedBadge => typeof badge?.badge_id === "number";

function currentUserId() {
    return UserStore.getCurrentUser()?.id;
}

function storeIsPatched() {
    return typeof BadgeDirectoryStore[ORIGINAL_CATALOG] === "function";
}

/** Discord's badge list without our changes, or an empty one if Discord changed the store */
function rawCatalog(userId: string) {
    return BadgeDirectoryStore[ORIGINAL_CATALOG]?.(userId) ?? [];
}

function refresh() {
    revision++;
    ownBadgeCache = new WeakMap();
    detailedBadgeCache = new WeakMap();
    BadgeDirectoryStore.emitChange();
    if (settings.store.shareSelections) schedulePublish();
}

function setChoice(badgeId: number, change: BadgeChoice) {
    guard("CHOICE_SAVE", () => undefined, () => {
        // settings.plain because a spread of settings.store copies proxies, which can't be cloned when settings save
        const { choices } = savedSettings();
        settings.store.choices = { ...choices, [badgeId]: { ...choices[badgeId], ...change } };
        refresh();
    });
}

function requestCatalog(userId: string) {
    if (catalogRequested || BadgeDirectoryStore.hasCatalogFor(userId)) return;
    catalogRequested = true;
    setTimeout(() => {
        try {
            fetchBadgeCatalog(userId).catch(e => report("CATALOG_FETCH", e));
        } catch (e) {
            report("CATALOG_FETCH", e);
        }
    });
}

function sharedFor(bio?: string | null) {
    if (!bio) return null;

    let shared = sharedByBio.get(bio);
    if (shared === undefined) {
        shared = decodeShare(bio);
        sharedByBio.set(bio, shared);
    }
    return shared;
}

function sharedForUser(userId: string) {
    return savedSettings().seeShared ? sharedFor(UserProfileStore.getUserProfile(userId)?.bio) : null;
}

function ownBadge(badge: DirectoryBadge) {
    let result = ownBadgeCache.get(badge);
    if (!result) {
        const { choices, learnedDetails } = savedSettings();
        result = applyChoice(badge, choices[badge.badge_id], learnedDetails[badge.badge_id]);
        ownBadgeCache.set(badge, result);
    }
    return result;
}

function detailedBadge(badge: DirectoryBadge) {
    let detailed = detailedBadgeCache.get(badge);
    if (!detailed) {
        detailed = withBadgeDetails(badge, savedSettings().learnedDetails[badge.badge_id]);
        detailedBadgeCache.set(badge, detailed);
    }
    return detailed;
}

/**
 * Someone's badges as they shared them. The profile row and the badge window both read this, so they always agree.
 * Discord only lists badges a person owns, so shared ones they don't own are built from your own copy of that badge.
 */
function sharedCatalog(userId: string, shared: SharedBadges): SharedCatalog {
    const me = currentUserId();
    const theirs = rawCatalog(userId).filter(isDiscordBadge);
    const mine = me ? rawCatalog(me).filter(isDiscordBadge) : [];
    const sources = [...theirs, ...mine];

    const cached = sharedCatalogs.get(userId);
    if (cached && cached.shared === shared && cached.revision === revision
        && cached.sources.length === sources.length && cached.sources.every((badge, i) => badge === sources[i])) {
        return cached;
    }

    const { learnedDetails } = savedSettings();
    const theirById = new Map(theirs.map(badge => [badge.badge_id, badge]));
    const mineById = new Map(mine.map(badge => [badge.badge_id, badge]));

    const badges: NumberedBadge[] = [];
    for (const [id, tierIndex] of shared) {
        const own = mineById.get(id);
        const source = theirById.get(id) ?? (own && asTemplate(own));
        if (!source) continue;
        badges.push({ ...applyShared(source, tierIndex, learnedDetails[id]), badge_id: id });
    }
    for (const badge of theirs) {
        if (!shared.has(badge.badge_id)) badges.push({ ...applyShared(badge, undefined, learnedDetails[badge.badge_id]), badge_id: badge.badge_id });
    }

    const result = { shared, revision, sources, badges, byId: new Map(badges.map(badge => [badge.badge_id, badge])) };
    sharedCatalogs.delete(userId);
    sharedCatalogs.set(userId, result);
    if (sharedCatalogs.size > SHARED_CACHE_LIMIT) sharedCatalogs.delete(sharedCatalogs.keys().next().value as string);
    return result;
}

function toProfileBadge(badge: NumberedBadge, originals: Map<number, ProfileBadge>, hasCustomTier: (badgeId: number) => boolean): ProfileBadge | null {
    const original = originals.get(badge.badge_id);
    if (original && !hasCustomTier(badge.badge_id)) return original;

    const iconSrc = badgeIcon(badge) ?? original?.iconSrc;
    if (!iconSrc && !original?.icon) return null;

    const id = original?.id ?? BadgeIds.toLegacyId(badge.badge_id);
    return {
        ...original,
        id,
        icon: original?.icon ?? id,
        iconSrc,
        description: original?.description ?? badge.name
    };
}

/** Replaces the Discord badges in a profile's list and keeps ones from other plugins where they were */
function replaceDiscordBadges(badges: ProfileBadge[], shown: NumberedBadge[], hasCustomTier: (badgeId: number) => boolean) {
    const originals = new Map<number, ProfileBadge>();
    let firstDiscordBadge = -1;
    const others = badges.filter((badge, index) => {
        const badgeId = BadgeIds.toBadgeId(badge.id);
        if (badgeId == null) return true;

        if (firstDiscordBadge === -1) firstDiscordBadge = index;
        if (!originals.has(badgeId)) originals.set(badgeId, badge);
        return false;
    });

    const leading = firstDiscordBadge === -1 ? others.length : badges.slice(0, firstDiscordBadge).length;
    const replaced = shown.map(badge => toProfileBadge(badge, originals, hasCustomTier)).filter(badge => badge != null);
    return [...others.slice(0, leading), ...replaced, ...others.slice(leading)];
}

function encodeOwnBadges(userId: string) {
    const shown = BadgeDirectoryStore.getBadges(userId).filter(isDiscordBadge).filter(badge => !badge.hidden);
    const entries = shown.map(badge => ({
        id: badge.badge_id,
        tierIndex: Math.max(badge.tiers?.findIndex((tier: BadgeTier) => tier.key === badge.current_tier) ?? 0, 0)
    }));
    if (entries.some(({ id, tierIndex }) => id >= 36 || tierIndex >= 36)) report("SHARE_UNSUPPORTED");

    return encodeShare(entries);
}

async function publishShare() {
    const userId = currentUserId();
    if (!userId || !BadgeDirectoryStore.hasCatalogFor(userId)) return;

    try {
        const profile = await fetchUserProfile(userId, undefined, false);
        const current = profile?.bio ?? "";
        const bio = stripShare(current) + (settings.store.shareSelections ? encodeOwnBadges(userId) : "");
        if (bio === current) return;

        if (bio.length > BIO_LIMIT) {
            report("SHARE_TOO_LONG");
            return;
        }

        await RestAPI.patch({ url: Constants.Endpoints.USER_PROFILE("@me"), body: { bio } });
        await fetchUserProfile(userId, undefined, false);
    } catch (e) {
        report("SHARE_PUBLISH", e);
    }
}

function schedulePublish() {
    clearTimeout(publishTimer);
    publishTimer = setTimeout(publishShare, PUBLISH_DELAY);
}

function checkHealth() {
    if (!storeIsPatched()) report("PATCH_MISSING", "BadgeDirectoryStore is not patched");
    try {
        if (typeof BadgeIds.toBadgeId !== "function" || typeof BadgeIds.toLegacyId !== "function") report("BADGE_IDS", "Badge id helpers missing");
    } catch (e) {
        report("BADGE_IDS", e);
    }
}

function useBadgeRevision() {
    return useStateFromStores([BadgeDirectoryStore], () => revision);
}

function BadgeSelect() {
    useBadgeRevision();
    const userId = currentUserId();
    const badges = BadgeDirectoryStore.getBadges(userId).filter(isDiscordBadge);

    if (!badges.length) {
        if (userId) requestCatalog(userId);
        return <div className={cl("empty")}>Your badges are loading.</div>;
    }

    const icons = new Map(badges.map(badge => [badge.badge_id, badgeIcon(badge)]));

    return (
        <>
            <SearchableSelect
                multi
                closeOnSelect={false}
                placeholder="All badges hidden"
                options={badges.map(badge => ({ label: badge.name, value: badge.badge_id }))}
                value={badges.filter(badge => !badge.hidden).map(badge => badge.badge_id)}
                onChange={(values: number[]) => guard("CHOICE_SAVE", () => undefined, () => {
                    const visible = new Set(values);
                    const choices = { ...savedSettings().choices };
                    for (const { badge_id } of badges) {
                        choices[badge_id] = { ...choices[badge_id], hidden: !visible.has(badge_id) };
                    }
                    settings.store.choices = choices;
                    refresh();
                })}
                renderOptionPrefix={option => {
                    const icon = option && icons.get(option.value);
                    return icon ? <img className={cl("icon")} src={icon} alt="" /> : null;
                }}
            />
            <div className={cl("actions")}>
                <Button size="small" variant="secondary" onClick={() => openBadgeDirectoryModal({ viewingCurrentUserBadges: true })}>
                    Manage Badges
                </Button>
                <Button
                    size="small"
                    variant="dangerSecondary"
                    onClick={() => {
                        settings.store.choices = {};
                        settings.store.order = [];
                        refresh();
                    }}
                >
                    Reset Choices
                </Button>
            </div>
        </>
    );
}

function diagnosticsLines() {
    const userId = currentUserId();
    const patched = storeIsPatched();
    const catalog = patched && userId ? rawCatalog(userId).filter(isDiscordBadge) : [];
    const newBadges = catalog.filter(badge => badge.badge_id > KNOWN_BADGE_COUNT).map(badge => badge.name);
    const errors = getErrors();

    return [
        `AAB diagnostics (Equicord ${VERSION})`,
        `Badge menus: ${patched ? "working" : `not patched (${ERRORS.PATCH_MISSING.code})`}`,
        `Discord experiment: ${experimentForced ? "on" : "not seen yet"}`,
        `Your badges: ${catalog.length ? `${catalog.length} loaded` : "not loaded yet"}`,
        `New badges Discord added: ${newBadges.length ? newBadges.join(", ") : "none"}`,
        `Sharing: ${settings.store.shareSelections ? "on" : "off"}, showing others' choices: ${settings.store.seeShared ? "on" : "off"}`,
        errors.length ? "Errors this session:" : "Errors this session: none",
        ...errors.map(e => `${e.code} x${e.count}: ${e.message}${e.detail ? ` [${e.detail}]` : ""}`)
    ];
}

function Diagnostics() {
    useBadgeRevision();
    const lines = diagnosticsLines();

    return (
        <div className={cl("diagnostics")}>
            {lines.slice(1).map(line => <div key={line} className={cl("diagnostics-line")}>{line}</div>)}
            <div className={cl("actions")}>
                <Button size="small" variant="secondary" onClick={() => copyWithToast(lines.join("\n"), "Diagnostics copied.")}>
                    Copy Diagnostics
                </Button>
            </div>
        </div>
    );
}

const SettingsBadgeSection = ErrorBoundary.wrap(function SettingsBadgeSection() {
    return (
        <SettingsSection title={TITLE} description={DESCRIPTION}>
            <BadgeSelect />
        </SettingsSection>
    );
}, { noop: true });

const PanelBadgeSection = ErrorBoundary.wrap(function PanelBadgeSection({ guildId }: { guildId?: string | null; }) {
    const Section = plugin.PanelSection;
    // Badges are account-wide, so only show this while editing the main profile
    if (!Section || guildId != null) return null;

    return (
        <Section heading={TITLE}>
            <div className={cl("panel-description")}>{DESCRIPTION}</div>
            <BadgeSelect />
        </Section>
    );
}, { noop: true });

const BadgeVisibilityButton = ErrorBoundary.wrap(function BadgeVisibilityButton({ badge, isViewingOtherUser }: BadgeDetailProps) {
    if (isViewingOtherUser || !isDiscordBadge(badge)) return null;

    const label = badge.hidden ? "Show on Profile" : "Hide from Profile";
    const Icon = badge.hidden ? EyeSlashIcon : EyeIcon;

    return (
        <Tooltip text={label}>
            {tooltipProps => (
                <Clickable
                    {...tooltipProps}
                    className={cl("visibility")}
                    aria-label={label}
                    aria-pressed={!badge.hidden}
                    onClick={() => setChoice(badge.badge_id, { hidden: !badge.hidden })}
                >
                    <Icon size="sm" color="currentColor" />
                </Clickable>
            )}
        </Tooltip>
    );
}, { noop: true });

migratePluginSettings("AAB", "HideMyBadges");

const plugin = definePlugin({
    name: "AAB",
    description: "Show, hide, reorder and pick tiers for every Discord badge from Discord's own badge menus. Client-side, with optional sharing between people who use this plugin.",
    authors: [{ name: "You", id: 0n }],
    dependencies: ["BadgeAPI"],
    settings,

    /** Section wrapper of the in-profile editor, grabbed by a patch since the module doesn't export it */
    PanelSection: null as ComponentType<{ heading: ReactNode; children?: ReactNode; }> | null,

    patches: [
        // Wrap DisplayProfile#getBadges. BadgeAPI patches the same method first, so Vencord/Equicord badges are included.
        {
            find: "getLegacyUsername(){",
            replacement: {
                match: /getBadges\(\)\{/,
                replace: `getBadges(){return $self.profileBadges(this,this.${ORIGINAL_GET_BADGES}())}${ORIGINAL_GET_BADGES}(){`
            }
        },
        // Every badge menu reads from this store, so choices apply to all of them at once
        {
            find: '"BadgeDirectoryStore"',
            replacement: [
                {
                    match: /getBadges\((\i)\)\{/,
                    replace: `getBadges($1){return $self.catalog(this.${ORIGINAL_CATALOG}($1),$1)}${ORIGINAL_CATALOG}($1){`
                },
                {
                    match: /getBadgeById\((\i),(\i)\)\{/,
                    replace: `getBadgeById($1,$2){return $self.badge(this.${ORIGINAL_BADGE}($1,$2),$2,$1)}${ORIGINAL_BADGE}($1,$2){`
                }
            ]
        },
        {
            find: '"2026-08-badge-management"',
            replacement: {
                match: /\(0,\i\(\d+\)\.\i\)\(\{name:"2026-08-badge-management".{0,200}?\}\}\}\)/,
                replace: "$self.forceExperiment($&)"
            }
        },
        // Lets every badge be hidden, and drops the personalization requirement on activity badges
        {
            find: '.milestone_text??""',
            replacement: [
                {
                    match: /(?<=tenureBadgeHideable:\i\}=\i;return new Set\()/,
                    replace: "[]||"
                },
                {
                    match: /(?<=let \i=new Set\()\[\i\.\i\.GAME_VARIETY,\i\.\i\.GAME_TIME,\i\.\i\.STREAMING\]/,
                    replace: "[]"
                }
            ]
        },
        // Native hide and reorder would save to your account, so keep them local
        {
            find: '"USER_PROFILE_SETTINGS_SET_PENDING_CHANGES",pendingBadgeDisplayOrder:',
            replacement: [
                {
                    match: /function \i\((\i)\)\{(?=var \i;let \i=\i\(\),\i=null!=\i&&\(\i=\i\.displayOrder)/,
                    replace: "$&return $self.setOrder($1);"
                },
                {
                    match: /function \i\((\i)\)\{(?=var \i,\i;let \i,\i,\{badgeId:)/,
                    replace: "$&return $self.setVisibility($1);"
                }
            ]
        },
        // Re-render the badge row when a choice changes
        {
            find: 'location:"UserProfileBadgeListRows"',
            replacement: {
                match: /\(0,\i\.\i\)\(\{location:"UserProfileBadgeListRows"\}\)/,
                replace: "($self.useBadgeRevision(),$&)"
            }
        },
        {
            find: '"badge_directory_closed"',
            replacement: [
                {
                    match: /(?<=\.tiers\.map\((\i)=>\{.{0,400}?role:"listitem",)/g,
                    replace: "...$self.tierProps(arguments[0],$1),"
                },
                {
                    match: /null!=(\i)\.simple_icon_url&&\(0,\i\.jsx\)\("img",\{(?=src:\1\.simple_icon_url)/,
                    replace: '$&"data-vc-hmb-hidden":$1.hidden===true,'
                },
                // Next to the close button of both detail panels, with 2026-10-badge-directory-updates on and off
                {
                    match: /(?<=children:\[)(?=\(0,\i\.jsx\)\("div",\{className:\i\.\i,children:\(0,\i\.jsx\)\(\i\.\i,\{onClick:\i,size:"sm"\}\)\}\))/g,
                    replace: "$self.renderVisibilityButton(arguments[0]),"
                }
            ]
        },
        // Settings > Profiles: new section right after Discord's own "Badges" section
        {
            find: '"DefaultCustomizationSections: user cannot be undefined"',
            replacement: {
                match: /\(0,\i\.jsx\)\(\i,\{\},"badges"\)/,
                replace: "$&,$self.renderSettingsSection()"
            }
        },
        // "Edit Profile" from the profile itself (2026-03-wysiwyg-user-profile-editing)
        {
            find: '("UserProfileModalV2EditingPanel")',
            replacement: [
                {
                    match: /(?=function (\i)\(\i\)\{let\{heading:\i,children:\i,disabled:\i=!1,showNitroIcon:)/,
                    replace: "$self.PanelSection=$1;"
                },
                {
                    // Last editing section in the panel, before the Nitro try-it-out block
                    match: /\(0,\i\.jsx\)\(\i,\{user:\i,guildId:(\i),disabled:\i\|\|\i\}\)(?=,\i&&\(0,\i\.jsxs\))/,
                    replace: "$&,$self.renderPanelSection($1)"
                }
            ]
        }
    ],

    useBadgeRevision,

    flux: {
        CONNECTION_OPEN() {
            const userId = currentUserId();
            if (userId) requestCatalog(userId);
        },
        BADGE_DIRECTORY_FETCH_FAILURE({ userId }: { userId: string; }) {
            if (userId !== currentUserId()) return;

            report("CATALOG_FETCH", "Badge catalog request failed");
            clearTimeout(retryTimer);
            retryTimer = setTimeout(() => {
                catalogRequested = false;
                requestCatalog(userId);
            }, CATALOG_RETRY_DELAY);
        },
        BADGE_DIRECTORY_FETCH_SUCCESS({ badges }: { badges: DirectoryBadge[]; }) {
            if (!Array.isArray(badges)) return;

            const learned = { ...savedSettings().learnedDetails };
            let changed = false;
            for (const { badge_id, owned, description, info_label } of badges) {
                if (!owned || !description || !isLearnableBadge(badge_id)) continue;

                const known = learned[badge_id];
                if (known?.description === description && known.info_label === info_label) continue;
                learned[badge_id] = { description, info_label };
                changed = true;
            }
            if (!changed) return;

            settings.store.learnedDetails = learned;
            revision++;
            ownBadgeCache = new WeakMap();
            detailedBadgeCache = new WeakMap();
        }
    },

    start() {
        const userId = currentUserId();
        if (userId) requestCatalog(userId);
        healthTimer = setTimeout(checkHealth, HEALTH_CHECK_DELAY);
    },

    stop() {
        clearTimeout(publishTimer);
        clearTimeout(retryTimer);
        clearTimeout(healthTimer);
    },

    forceExperiment(experiment: BadgeExperiment) {
        if (typeof experiment?.getConfig !== "function" || typeof experiment.useConfig !== "function") {
            logger.warn("Badge management experiment has an unexpected shape, leaving it alone");
            return experiment;
        }

        const force = (config: object) => ({ ...config, enabled: true, tenureBadgeHideable: true });
        const { getConfig, useConfig } = experiment;

        experiment.getConfig = options => force(getConfig.call(experiment, options));
        experiment.useConfig = options => force(useConfig.call(experiment, options));
        experimentForced = true;
        return experiment;
    },

    badge(badge: DirectoryBadge | undefined, userId?: string, badgeId?: number) {
        return guard("BADGE_RENDER", () => badge, () => {
            const me = currentUserId();
            if ((userId ?? me) !== me && userId) {
                const shared = sharedForUser(userId);
                const id = badge?.badge_id ?? badgeId;
                if (shared && typeof id === "number") return sharedCatalog(userId, shared).byId.get(id) ?? badge;
            }

            if (!isDiscordBadge(badge)) return badge;
            return (userId ?? me) === me ? ownBadge(badge) : detailedBadge(badge);
        });
    },

    catalog(badges: DirectoryBadge[], userId?: string) {
        return guard("BADGE_RENDER", () => badges, () => {
            const me = currentUserId();
            if ((userId ?? me) !== me && userId) {
                const shared = sharedForUser(userId);
                if (shared) return sharedCatalog(userId, shared).badges;
                return badges.map(badge => isDiscordBadge(badge) ? detailedBadge(badge) : badge);
            }

            // Same order as Discord: Staff, shown badges in your order, hidden badges you own, then the rest in catalog order
            const { order } = savedSettings();
            const position = new Map(order.map((id, index) => [id, index]));
            const ranked = badges.map(raw => {
                if (!isDiscordBadge(raw)) return { badge: raw, group: 4, position: 0 };

                const badge = ownBadge(raw);
                const group = raw.badge_id === STAFF_BADGE_ID ? 0 : !badge.hidden ? 1 : raw.owned ? 2 : 3;
                return { badge, group, position: group === 1 ? position.get(raw.badge_id) ?? order.length : 0 };
            });

            return ranked.sort((a, b) => a.group - b.group || a.position - b.position).map(({ badge }) => badge);
        });
    },

    profileBadges(profile: DisplayProfile, badges: ProfileBadge[]) {
        return guard("PROFILE_RENDER", () => badges, () => {
            const userId = profile?.userId;
            const me = currentUserId();
            if (!Array.isArray(badges) || !userId || !me || !storeIsPatched()) return badges;

            if (!BadgeDirectoryStore.hasCatalogFor(me)) {
                requestCatalog(me);
                return badges;
            }

            if (userId === me) {
                const { choices } = savedSettings();
                return replaceDiscordBadges(
                    badges,
                    BadgeDirectoryStore.getBadges(me).filter(isDiscordBadge).filter(badge => !badge.hidden),
                    badgeId => choices[badgeId]?.tier != null
                );
            }

            const shared = sharedForUser(userId);
            if (!shared) return badges;

            return replaceDiscordBadges(badges, sharedCatalog(userId, shared).badges.filter(badge => badge.owned), () => true);
        });
    },

    setOrder(order: number[]) {
        guard("CHOICE_SAVE", () => undefined, () => {
            settings.store.order = Array.isArray(order) ? [...order] : [];
            refresh();
        });
    },

    setVisibility({ badgeId, hidden, reorderableBadgeIds, canReorder }: { badgeId: number; hidden: boolean; reorderableBadgeIds: number[]; canReorder: boolean; }) {
        guard("CHOICE_SAVE", () => undefined, () => {
            if (canReorder && Array.isArray(reorderableBadgeIds)) {
                settings.store.order = hidden ? reorderableBadgeIds.filter(id => id !== badgeId) : [...reorderableBadgeIds, badgeId];
            }
            setChoice(badgeId, { hidden });
        });
    },

    tierProps({ badge, isViewingOtherUser }: BadgeDetailProps, tier: BadgeTier) {
        if (isViewingOtherUser || !isDiscordBadge(badge) || !tier?.key) return null;

        const selected = badge.current_tier === tier.key;
        const select = () => {
            const choice = savedSettings().choices[badge.badge_id];
            const change: BadgeChoice = { tier: choice?.tier === tier.key ? undefined : tier.key };
            if (choice?.hidden == null && badge.hidden) change.hidden = false;
            setChoice(badge.badge_id, change);
        };

        return {
            role: "button",
            tabIndex: 0,
            "aria-pressed": selected,
            "data-vc-hmb-tier": selected ? "selected" : "available",
            onClick: select,
            onKeyDown: (event: KeyboardEvent) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                select();
            }
        };
    },

    renderVisibilityButton(props: BadgeDetailProps) {
        return <BadgeVisibilityButton key="vc-hmb-visibility" {...props} />;
    },

    renderSettingsSection() {
        return <SettingsBadgeSection key="vc-hide-my-badges" />;
    },

    renderPanelSection(guildId?: string | null) {
        return <PanelBadgeSection key="vc-hide-my-badges" guildId={guildId} />;
    }
});

export default plugin;
