import { useGatewayLogDeletion } from "./useGatewayLogDeletion";
import { isAxiosError } from "@frontend-core/api/createApiClient";
import { useGatewayLogFilterActions } from "./useGatewayLogFilterActions";
import { isValidAnalyticsRange } from "../request-analysis/model";
import {
  useGatewayLogDates,
  useGatewayLogDateState,
} from "./useGatewayLogDates";
import { useGatewayLogFilterLabels } from "./useGatewayLogFilterLabels";
import { useRoute } from "vue-router";
import { useGatewayLogIpView } from "./useGatewayLogIpView";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { extractErrorMessage } from "@admin-shared/composables/useAsyncAction";
import { useDelayedLoading } from "@admin-shared/composables/useDelayedLoading";
import { toast } from "@admin-shared/utils/toast";
import { useCursorPagination } from "@/composables/useCursorPagination";
import { useIpLocationBatch } from "@/composables/useIpLocationBatch";
import { ConfigAPI } from "@/lib/api/config";
import { GatewayLogsAPI } from "@/lib/api/gateway";
import { useConfigStore } from "@/store/config";
import type { GatewayLogEntry, TOTPCredential } from "@/types";
import {
  getEntryClientIp,
  type GatewayLoginFilterValue,
  type GatewayStatusFilterValue,
  type GatewayWAFFilterValue,
} from "./model";
export const useGatewayRequestLogsResource = () => {
  const route = useRoute();
  const configStore = useConfigStore();
  const { t } = useI18n();
  let isDisposed = false;
  let entriesRequestId = 0;
  const entries = ref<GatewayLogEntry[]>([]);
  const logsDir = ref("");
  const availableDates = ref<string[]>([]);
  const { selectedDate, selectedEndDate, serverToday, rangeLabel } =
    useGatewayLogDateState(route.query);
  const selectedStatus = ref<GatewayStatusFilterValue>("all");
  const selectedLoggedIn = ref<GatewayLoginFilterValue>("all");
  const selectedCredential = ref("all");
  const selectedWAFStatus = ref<GatewayWAFFilterValue>("all");
  const limit = ref("20");
  const searchQuery = ref("");
  const loading = ref(false);
  const credentialOptions = ref<TOTPCredential[]>([]);
  const selectedLogEntryKeys = ref<Set<string>>(new Set());
  const {
    canLoadNewer: canLoadNewerEntries,
    canLoadOlder: canLoadOlderEntries,
    currentCursor,
    cursorHistory,
    loadFirst: loadCursorFirst,
    loadNewer: loadCursorNewer,
    loadOlder: loadCursorOlder,
    nextCursor,
    reset: resetCursorPagination,
  } = useCursorPagination({ loading });
  const { trackIps, getSnapshot } = useIpLocationBatch();
  const ipView = useGatewayLogIpView({
    loading,
    selectedDate,
    selectedEndDate,
    searchQuery,
    selectedStatus,
    selectedLoggedIn,
    selectedCredential,
    selectedWAFStatus,
    limit,
    selectedLogEntryKeys,
    resetCursorPagination,
    trackIps,
    invalidateRequest: () => {
      entriesRequestId += 1;
      loading.value = false;
    },
    fetchEntries: () => fetchEntries(),
    applyFilter: (update) => applyFilter(update),
  });
  const {
    clientIp,
    isIpOverview,
    ipGroups,
    ipPage,
    ipSort,
    ipOrder,
    requestOrder,
    detailRequests,
    loadError,
  } = ipView;

  const showTableSkeleton = useDelayedLoading(
    () => loading.value && entries.value.length === 0,
  );
  const isLoggingEnabled = computed(
    () => configStore.config?.gateway_logging?.enabled ?? false,
  );
  const {
    activeStatusLabel,
    activeLoggedInLabel,
    credentialFilterOptions,
    activeCredentialLabel,
    activeWAFStatusLabel,
  } = useGatewayLogFilterLabels({
    selectedStatus,
    selectedLoggedIn,
    selectedCredential,
    selectedWAFStatus,
    credentialOptions,
  });
  const canLoadNewer = computed(() =>
    isIpOverview.value ? ipPage.value > 1 : canLoadNewerEntries.value,
  );
  const canLoadOlder = computed(() =>
    isIpOverview.value
      ? ipPage.value * Number(limit.value) < (ipGroups.value?.total ?? 0)
      : canLoadOlderEntries.value,
  );
  const cursorPageLabel = computed(() =>
    t(
      isIpOverview.value
        ? "admin.gatewayRequestLogs.ipView.page"
        : "admin.gatewayRequestLogs.cursorPage",
      {
        page: isIpOverview.value
          ? ipPage.value
          : cursorHistory.value.length + 1,
      },
    ),
  );
  const shouldFloatPagination = computed(
    () =>
      (isIpOverview.value
        ? (ipGroups.value?.items.length ?? 0) > 0
        : entries.value.length > 0) ||
      canLoadNewer.value ||
      canLoadOlder.value,
  );
  const { isDeleting, deleteDate } = useGatewayLogDeletion();

  const { applyDates, fetchDates } = useGatewayLogDates({
    selectedDate,
    selectedEndDate,
    serverToday,
    availableDates,
    logsDir,
    currentRequest: () => {
      const id = entriesRequestId;
      return () => !isDisposed && id === entriesRequestId;
    },
  });

  const fetchCredentialOptions = async () => {
    try {
      const data = await ConfigAPI.getTOTPStatus();
      if (isDisposed) return;
      credentialOptions.value = data.credentials || [];
    } catch {
      if (isDisposed) return;
      credentialOptions.value = [];
    }
  };

  const fetchEntries = async () => {
    const currentRequestId = ++entriesRequestId;
    if (
      !isValidAnalyticsRange(
        selectedDate.value,
        selectedEndDate.value,
        serverToday.value,
      )
    ) {
      loading.value = false;
      loadError.value = true;
      toast.error(t("admin.gatewayRequestLogs.range.invalid"));
      return;
    }
    const params = {
      from: selectedDate.value,
      to: selectedEndDate.value,
      pagination: "cursor" as const,
      limit: limit.value,
      cursor: currentCursor.value || undefined,
      search: searchQuery.value || undefined,
      status: selectedStatus.value === "all" ? undefined : selectedStatus.value,
      logged_in:
        selectedLoggedIn.value === "all" ? undefined : selectedLoggedIn.value,
      credential:
        selectedCredential.value === "all"
          ? undefined
          : selectedCredential.value,
      waf_status:
        selectedWAFStatus.value === "all" ? undefined : selectedWAFStatus.value,
      client_ip: clientIp.value || undefined,
    };
    loading.value = true;
    loadError.value = false;
    try {
      if (isIpOverview.value) {
        const data = await GatewayLogsAPI.getIpGroups({
          ...params,
          page: ipPage.value,
          sort: ipSort.value,
          order: ipOrder.value,
        });
        if (isDisposed || currentRequestId !== entriesRequestId) return;
        ipGroups.value = data;
        ipPage.value = data.page;
        trackIps(data.items.map((item) => item.client_ip));
        return;
      }
      const [data, summary] = await Promise.all([
        GatewayLogsAPI.getEntries({
          ...params,
          sort: "time",
          order: requestOrder.value,
        }),
        clientIp.value && !currentCursor.value && detailRequests.value === null
          ? GatewayLogsAPI.getIpGroups({ ...params, page: 1, limit: "1" })
          : Promise.resolve(null),
      ]);
      if (isDisposed || currentRequestId !== entriesRequestId) return;
      if (summary) detailRequests.value = summary.total_requests;
      logsDir.value = data.logs_dir || "";
      entries.value = data.items || [];
      selectedLogEntryKeys.value = new Set();
      trackIps(entries.value.map(getEntryClientIp));
      nextCursor.value = data.next_cursor || "";
      if (!currentCursor.value && data.cursor)
        currentCursor.value = data.cursor;
      applyDates(data.available_dates || [], params.from);
    } catch (error) {
      if (isDisposed || currentRequestId !== entriesRequestId) return;
      loadError.value = true;
      ipGroups.value = null;
      detailRequests.value = null;
      entries.value = [];
      trackIps([]);
      nextCursor.value = "";
      const cursorExpired =
        isAxiosError(error) && error.response?.status === 409;
      if (cursorExpired) resetCursorPagination();
      toast.error(t("admin.gatewayRequestLogs.loadFailed"), {
        description: cursorExpired
          ? t("admin.gatewayLogging.cursorExpired")
          : extractErrorMessage(
              error,
              t("admin.gatewayRequestLogs.loadFailedDescription"),
            ),
      });
    } finally {
      if (currentRequestId === entriesRequestId) loading.value = false;
    }
  };

  const refreshAll = async () => {
    selectedLogEntryKeys.value = new Set();
    const requestId = ++entriesRequestId;
    loading.value = true;
    await Promise.all([
      fetchDates(selectedDate.value),
      fetchCredentialOptions(),
    ]);
    if (isDisposed || requestId !== entriesRequestId) return;
    resetCursorPagination();
    ipPage.value = 1;
    detailRequests.value = null;
    await fetchEntries();
  };

  const applyFilter = async (update: () => void) => {
    update();
    selectedLogEntryKeys.value = new Set();
    resetCursorPagination();
    ipPage.value = 1;
    detailRequests.value = null;
    await Promise.all([ipView.syncDateQuery(), fetchEntries()]);
  };

  const filterActions = useGatewayLogFilterActions({
    selectedDate,
    selectedEndDate,
    serverToday,
    selectedStatus,
    selectedLoggedIn,
    selectedCredential,
    selectedWAFStatus,
    limit,
    applyFilter,
  });

  const handleLoadOlder = () => ipView.loadPage("older", loadCursorOlder);
  const handleLoadNewer = () => ipView.loadPage("newer", loadCursorNewer);
  const handleLoadFirst = () => ipView.loadPage("first", () => loadCursorFirst(true));

  const deleteSelectedDate = async () => {
    if (selectedDate.value !== selectedEndDate.value) return;
    const date = selectedDate.value;
    const requestId = entriesRequestId;
    await deleteDate(date, async (data) => {
      const stale = isDisposed || requestId !== entriesRequestId;
      ipView.invalidateOverview(stale);
      if (stale) return;
      searchQuery.value = "";
      selectedStatus.value = "all";
      selectedLoggedIn.value = "all";
      selectedCredential.value = "all";
      selectedWAFStatus.value = "all";
      selectedDate.value =
        data.available_dates.find((item) => item !== date) || serverToday.value;
      selectedEndDate.value = selectedDate.value;
      await Promise.all([ipView.syncDateQuery(), refreshAll()]);
    });
  };

  onMounted(async () => {
    const requestId = entriesRequestId;
    loading.value = true;
    await Promise.all([
      fetchDates(
        typeof route.query.log_from === "string" ||
          typeof route.query.log_date === "string"
          ? selectedDate.value
          : undefined,
      ),
      fetchCredentialOptions(),
    ]);
    if (isDisposed || requestId !== entriesRequestId) return;
    await ipView.syncDateQuery();
    await fetchEntries();
  });
  onBeforeUnmount(() => {
    isDisposed = true;
    entriesRequestId += 1;
  });

  return {
    ...ipView,
    ...filterActions,
    retry: fetchEntries,
    activeCredentialLabel,
    activeLoggedInLabel,
    activeStatusLabel,
    activeWAFStatusLabel,
    availableDates,
    canLoadNewer,
    canLoadOlder,
    credentialFilterOptions,
    currentCursor,
    cursorPageLabel,
    deleteSelectedDate,
    entries,
    getSnapshot,
    handleLoadFirst,
    handleLoadNewer,
    handleLoadOlder,
    isDeleting,
    isLoggingEnabled,
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
    selectedLoggedIn,
    selectedLogEntryKeys,
    selectedStatus,
    selectedWAFStatus,
    shouldFloatPagination,
    showTableSkeleton,
  };
};
