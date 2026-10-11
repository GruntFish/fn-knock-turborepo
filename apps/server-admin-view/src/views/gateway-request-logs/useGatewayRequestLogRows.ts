import { computed, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import type { GatewayLogEntry } from "@/types";
import type { useGatewayRequestLogsResource } from "./useGatewayRequestLogsResource";
import {
  buildGatewayLogSelectionKey,
  getEntryActionIp,
  getEntryClientIp,
} from "./model";

export const useGatewayRequestLogRows = (
  resource: ReturnType<typeof useGatewayRequestLogsResource>,
  activeEntry: Ref<GatewayLogEntry | null>,
) => {
  const { entries, currentCursor, getSnapshot, isIpOverview, ipGroups } =
    resource;
  const { t } = useI18n();
  const getEntrySelectionKey = (entry: GatewayLogEntry, index: number) =>
    buildGatewayLogSelectionKey(entry, index, currentCursor.value);
  const getEntryIpSnapshot = (entry: GatewayLogEntry) =>
    getSnapshot(getEntryClientIp(entry));
  const getEntryIpLocation = (entry: GatewayLogEntry) =>
    getEntryIpSnapshot(entry)?.location || entry.ipLocation || "";
  const getEntryIpLocationText = (entry: GatewayLogEntry) => {
    const snapshot = getEntryIpSnapshot(entry);
    const location = snapshot?.location || entry.ipLocation || "";
    if (location) return location;
    if (snapshot?.status === "queued" || snapshot?.status === "processing") {
      return t("admin.hostActiveIps.resolving");
    }
    if (snapshot?.status === "failed") {
      return t("admin.hostActiveIps.unavailable");
    }
    return "";
  };
  const getConnectionSourceText = (entry: GatewayLogEntry) => {
    const clientIp = getEntryClientIp(entry);
    const remoteIp = entry.remote_ip || "";
    if (!remoteIp || remoteIp === clientIp) return "";
    return t("admin.gatewayRequestLogs.connectionSource", { ip: remoteIp });
  };
  const displayedEntries = computed(() =>
    entries.value.map((entry, index) => ({
      ...entry,
      client_ip: getEntryClientIp(entry),
      ipLocation: getEntryIpLocation(entry),
      actionIp: getEntryActionIp(entry),
      selectionKey: getEntrySelectionKey(entry, index),
    })),
  );

  const selectableEntries = computed(() =>
    isIpOverview.value
      ? (ipGroups.value?.items ?? []).map((item) => ({
          actionIp: item.client_ip,
          selectionKey: item.client_ip,
        }))
      : displayedEntries.value,
  );
  const activeEntryWithIpLocation = computed(() =>
    activeEntry.value
      ? {
          ...activeEntry.value,
          client_ip: getEntryClientIp(activeEntry.value),
          ipLocation: getEntryIpLocation(activeEntry.value),
        }
      : null,
  );
  return {
    displayedEntries,
    selectableEntries,
    getEntryIpLocationText,
    getConnectionSourceText,
    activeEntryWithIpLocation,
  };
};
