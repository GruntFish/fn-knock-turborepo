<script setup lang="ts">
import { ref } from "vue";
import GatewayLogDetails from "./gateway-request-logs/GatewayLogDetails.vue";
import GatewayLogViewHeader from "./gateway-request-logs/GatewayLogViewHeader.vue";
import { useGatewayLogIpPresentation } from "./gateway-request-logs/useGatewayLogIpPresentation";
import { Button } from "@/components/ui/button";
import GatewayLogIpGroups from "./gateway-request-logs/GatewayLogIpGroups.vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import type { GatewayLogEntry } from "../types";
import GatewayRequestLogsActions from "./gateway-request-logs/GatewayRequestLogsActions.vue";
import GatewayRequestLogsFilters from "./gateway-request-logs/GatewayRequestLogsFilters.vue";
import GatewayRequestLogsPagination from "./gateway-request-logs/GatewayRequestLogsPagination.vue";
import GatewayRequestLogsTable from "./gateway-request-logs/GatewayRequestLogsTable.vue";
import { useGatewayRequestLogRows } from "./gateway-request-logs/useGatewayRequestLogRows";
import { useGatewayLogIpSelection } from "./gateway-request-logs/useGatewayLogIpSelection";
import { useGatewayRequestLogsResource } from "./gateway-request-logs/useGatewayRequestLogsResource";
const router = useRouter();
const { t } = useI18n();
const isDetailsOpen = ref(false);
const activeEntry = ref<GatewayLogEntry | null>(null);
const resource = useGatewayRequestLogsResource();
const {
  viewMode,
  clientIp,
  isIpOverview,
  ipGroups,
  ipSort,
  ipOrder,
  requestOrder,
  handleOrderChange,
  detailRequests,
  loadError,
  hasFilters,
  backToIps,
  showAllIpRequests,
  setViewMode,
  handleIpSortChange,
  retry,
  activeCredentialLabel,
  activeLoggedInLabel,
  activeStatusLabel,
  activeWAFStatusLabel,
  availableDates,
  canLoadNewer,
  canLoadOlder,
  credentialFilterOptions,
  cursorPageLabel,
  deleteSelectedDate,
  entries,
  handleCredentialChange,
  handleDateChange,
  handleLimitChange,
  handleLoadFirst,
  handleLoadNewer,
  handleLoadOlder,
  handleLoggedInChange,
  handleSearch,
  handleStatusChange,
  handleWAFStatusChange,
  isDeleting,
  limit,
  loading,
  logsDir,
  refreshAll,
  searchQuery,
  selectedCredential,
  selectedDate,
  selectedEndDate,
  serverToday,
  rangeLabel,
  handleRangeChange,
  selectedLoggedIn,
  selectedLogEntryKeys,
  selectedStatus,
  selectedWAFStatus,
  shouldFloatPagination,
  showTableSkeleton,
} = resource;
const { setRootRef, handleOpenIp, ipLocation, ipSummary } =
  useGatewayLogIpPresentation(resource);
const viewDetails = (entry: GatewayLogEntry) => {
  activeEntry.value = entry;
  isDetailsOpen.value = true;
};
const goToWAFTrace = (traceId?: string) => {
  if (!traceId) return;
  router.push(`/traces/${encodeURIComponent(traceId)}`);
};
const {
  displayedEntries,
  selectableEntries,
  getEntryIpLocationText,
  getConnectionSourceText,
  activeEntryWithIpLocation,
} = useGatewayRequestLogRows(resource, activeEntry);

const {
  blockIpsFromLogs,
  hasSelectableDisplayedRows,
  isAllDisplayedRowsSelected,
  isBlockingIps,
  isGeneralBlacklisted,
  isMutatingBlacklistIps,
  isReleasingIps,
  releaseIpsFromLogs,
  selectedBlockedLogIps,
  selectedUnblockedLogIps,
  toggleLogEntrySelection,
} = useGatewayLogIpSelection({
  displayedEntries: selectableEntries,
  selectedLogEntryKeys,
  translate: (key, params) => (params ? t(key, params) : t(key)),
});
</script>

<template>
  <div :ref="setRootRef" class="flex h-full flex-col gap-3">
    <GatewayLogViewHeader
      :client-ip="clientIp"
      :view-mode="viewMode"
      :selected-date="rangeLabel"
      :detail-requests="detailRequests"
      :loading="loading"
      :has-filters="hasFilters"
      :ip-location="ipLocation"
      :set-view-mode="setViewMode"
      :back-to-ips="backToIps"
      :show-all-ip-requests="showAllIpRequests"
    />
    <Teleport defer to="#request-analysis-logs-actions">
      <GatewayRequestLogsActions
        :block-ips="blockIpsFromLogs"
        :delete-selected-date="deleteSelectedDate"
        :can-delete-date="selectedDate === selectedEndDate"
        :is-blocking="isBlockingIps"
        :is-deleting="isDeleting"
        :is-mutating="isMutatingBlacklistIps"
        :is-releasing="isReleasingIps"
        :loading="loading"
        :refresh="refreshAll"
        :release-ips="releaseIpsFromLogs"
        :selected-blocked-ips="selectedBlockedLogIps"
        :selected-date="selectedDate"
        :selected-unblocked-ips="selectedUnblockedLogIps"
      />
    </Teleport>

    <div
      class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background"
    >
      <GatewayRequestLogsFilters
        v-model:search-query="searchQuery"
        :summary="ipSummary"
        :active-credential-label="activeCredentialLabel"
        :active-logged-in-label="activeLoggedInLabel"
        :active-status-label="activeStatusLabel"
        :active-waf-status-label="activeWAFStatusLabel"
        :available-dates="availableDates"
        :credential-options="credentialFilterOptions"
        :cursor-page-label="cursorPageLabel"
        :entries-count="entries.length"
        :handle-credential-change="handleCredentialChange"
        :handle-date-change="handleDateChange"
        :handle-range-change="handleRangeChange"
        :selected-end-date="selectedEndDate"
        :server-today="serverToday"
        :show-request-sort="!isIpOverview"
        :request-order="requestOrder"
        :handle-order-change="handleOrderChange"
        :handle-logged-in-change="handleLoggedInChange"
        :handle-search="handleSearch"
        :handle-status-change="handleStatusChange"
        :handle-waf-status-change="handleWAFStatusChange"
        :logs-dir="logsDir"
        :selected-credential="selectedCredential"
        :selected-date="selectedDate"
        :selected-logged-in="selectedLoggedIn"
        :selected-status="selectedStatus"
        :selected-waf-status="selectedWAFStatus"
      />

      <div
        v-if="loadError"
        role="alert"
        class="flex min-h-48 flex-col items-center justify-center gap-3 p-4 text-sm text-muted-foreground"
      >
        <p>{{ t("admin.gatewayRequestLogs.loadFailed") }}</p>
        <Button variant="outline" @click="retry">{{
          t("admin.gatewayRequestLogs.ipView.retry")
        }}</Button>
      </div>
      <GatewayLogIpGroups
        v-else-if="isIpOverview"
        :data="ipGroups"
        :loading="loading"
        :sort="ipSort"
        :order="ipOrder"
        :selected-keys="selectedLogEntryKeys"
        :all-selected="isAllDisplayedRowsSelected"
        :is-blacklisted="isGeneralBlacklisted"
        :mutating="isMutatingBlacklistIps"
        :block="blockIpsFromLogs"
        :release="releaseIpsFromLogs"
        @select="toggleLogEntrySelection"
        @select-all="isAllDisplayedRowsSelected = $event"
        @order="handleOrderChange"
        :location="ipLocation"
        @open="handleOpenIp"
        @sort="handleIpSortChange"
      />
      <GatewayRequestLogsTable
        v-else
        v-model:is-all-displayed-rows-selected="isAllDisplayedRowsSelected"
        :block-ips-from-logs="blockIpsFromLogs"
        :entries="displayedEntries"
        :entries-count="entries.length"
        :get-connection-source-text="getConnectionSourceText"
        :get-entry-ip-location-text="getEntryIpLocationText"
        :go-to-waf-trace="goToWAFTrace"
        :has-selectable-displayed-rows="hasSelectableDisplayedRows"
        :is-general-blacklisted="isGeneralBlacklisted"
        :is-mutating-blacklist-ips="isMutatingBlacklistIps"
        :loading="loading"
        :release-ips-from-logs="releaseIpsFromLogs"
        :selected-log-entry-keys="selectedLogEntryKeys"
        :show-table-skeleton="showTableSkeleton"
        :toggle-log-entry-selection="toggleLogEntrySelection"
        :view-details="viewDetails"
      />

      <GatewayRequestLogsPagination
        :can-load-newer="canLoadNewer"
        :can-load-older="canLoadOlder"
        :cursor-page-label="cursorPageLabel"
        :handle-limit-change="handleLimitChange"
        :handle-load-first="handleLoadFirst"
        :handle-load-newer="handleLoadNewer"
        :handle-load-older="handleLoadOlder"
        :limit="limit"
        :loading="loading"
        :should-float="shouldFloatPagination"
      />
    </div>

    <GatewayLogDetails
      v-model:open="isDetailsOpen"
      :entry="activeEntryWithIpLocation"
    />
  </div>
</template>
