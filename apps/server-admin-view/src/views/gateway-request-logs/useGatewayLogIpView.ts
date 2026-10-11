import { computed, ref, watch, type Ref } from "vue";
import { useRoute, useRouter, type LocationQueryRaw } from "vue-router";
import { useStorage } from "@vueuse/core";
import type {
  GatewayLogIpGroups,
  GatewayLogIpGroupsQuery,
} from "@/lib/api/gateway";
import type {
  GatewayStatusFilterValue,
  GatewayLoginFilterValue,
  GatewayWAFFilterValue,
} from "./model";

type Order = "asc" | "desc";
const orderValue = (value: unknown): Order =>
  value === "asc" ? "asc" : "desc";
const sorts = [
  "requests",
  "last_seen",
  "client_errors",
  "server_errors",
  "waf_hits",
] as const;
const sortValue = (
  value: unknown,
): NonNullable<GatewayLogIpGroupsQuery["sort"]> =>
  sorts.find((sort) => sort === value) ?? "requests";
interface IpViewContext {
  loading: Ref<boolean>;
  selectedDate: Ref<string>;
  selectedEndDate: Ref<string>;
  searchQuery: Ref<string>;
  selectedStatus: Ref<GatewayStatusFilterValue>;
  selectedLoggedIn: Ref<GatewayLoginFilterValue>;
  selectedCredential: Ref<string>;
  selectedWAFStatus: Ref<GatewayWAFFilterValue>;
  limit: Ref<string>;
  selectedLogEntryKeys: Ref<Set<string>>;
  resetCursorPagination: () => void;
  invalidateRequest: () => void;
  trackIps: (ips: string[]) => void;
  fetchEntries: () => Promise<void>;
  applyFilter: (update: () => void) => Promise<void>;
}
export const useGatewayLogIpView = (context: IpViewContext) => {
  const {
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
    invalidateRequest,
    trackIps,
    fetchEntries,
    applyFilter,
  } = context;
  const route = useRoute();
  const router = useRouter();
  const viewMode = useStorage<"requests" | "ips">(
    "gateway-log-view",
    "requests",
  );
  if (route.query.log_view === "ips" || route.query.log_view === "requests")
    viewMode.value = route.query.log_view;
  const clientIp = computed(() =>
    typeof route.query.client_ip === "string" ? route.query.client_ip : "",
  );
  const isIpOverview = computed(
    () => viewMode.value === "ips" && !clientIp.value,
  );
  const ipGroups = ref<GatewayLogIpGroups | null>(null);
  const ipPage = ref(1);
  const ipSort = ref(sortValue(route.query.log_ip_sort));
  const ipOrder = ref<Order>(orderValue(route.query.log_ip_order));
  const requestOrder = ref<Order>(orderValue(route.query.log_order));
  const detailRequests = ref<number | null>(null);
  const loadError = ref(false);
  const hasFilters = computed(
    () =>
      Boolean(searchQuery.value.trim()) ||
      selectedStatus.value !== "all" ||
      selectedLoggedIn.value !== "all" ||
      selectedCredential.value !== "all" ||
      selectedWAFStatus.value !== "all",
  );
  const filtersSnapshot = () => ({
    date: selectedDate.value,
    endDate: selectedEndDate.value,
    search: searchQuery.value,
    status: selectedStatus.value,
    loggedIn: selectedLoggedIn.value,
    credential: selectedCredential.value,
    waf: selectedWAFStatus.value,
    limit: limit.value,
    sort: ipSort.value,
    order: ipOrder.value,
    requestOrder: requestOrder.value,
  });
  let overviewSnapshot: {
    filters: ReturnType<typeof filtersSnapshot>;
    groups: GatewayLogIpGroups | null;
    page: number;
  } | null = null;
  let openedFromOverview = false;
  const queryState = () => {
    const query: LocationQueryRaw = {
      ...route.query,
      log_from: selectedDate.value,
      log_to: selectedEndDate.value,
      log_order: requestOrder.value,
      log_ip_sort: ipSort.value,
      log_ip_order: ipOrder.value,
      log_view: viewMode.value,
    };
    delete query.log_date;
    return query;
  };
  const syncDateQuery = async () => {
    await router.replace({ query: queryState() });
  };
  const openIp = async (ip: string) => {
    overviewSnapshot = {
      filters: filtersSnapshot(),
      groups: ipGroups.value,
      page: ipPage.value,
    };
    openedFromOverview = true;
    await router.push({
      query: { ...queryState(), client_ip: ip || "unknown" },
    });
  };
  const backToIps = async () => {
    if (openedFromOverview) {
      router.back();
      return;
    }
    viewMode.value = "ips";
    const query = queryState();
    delete query.client_ip;
    await router.replace({ query });
  };
  const showAllIpRequests = () =>
    applyFilter(() => {
      searchQuery.value = "";
      selectedStatus.value = "all";
      selectedLoggedIn.value = "all";
      selectedCredential.value = "all";
      selectedWAFStatus.value = "all";
    });
  const setViewMode = async (value: "requests" | "ips") => {
    if (viewMode.value === value) return;
    await applyFilter(() => {
      viewMode.value = value;
    });
  };
  const handleIpSortChange = (value: unknown) =>
    applyFilter(() => {
      ipSort.value = sortValue(value);
      ipOrder.value = "desc";
    });
  const handleOrderChange = (value: unknown) =>
    applyFilter(() => {
      if (isIpOverview.value) ipOrder.value = orderValue(value);
      else requestOrder.value = orderValue(value);
    });
  const routeState = () => {
    const from =
      typeof route.query.log_from === "string"
        ? route.query.log_from
        : typeof route.query.log_date === "string"
          ? route.query.log_date
          : selectedDate.value;
    return {
      ip: clientIp.value,
      from,
      to: typeof route.query.log_to === "string" ? route.query.log_to : from,
      sort: sortValue(route.query.log_ip_sort),
      ipOrder: orderValue(route.query.log_ip_order),
      requestOrder: orderValue(route.query.log_order),
      mode:
        route.query.log_view === "ips" || route.query.log_view === "requests"
          ? route.query.log_view
          : viewMode.value,
    };
  };
  watch(
    () => JSON.stringify(route.query),
    async (_, previousQuery) => {
      const next = routeState();
      const previousIp =
        (JSON.parse(previousQuery) as Record<string, unknown>).client_ip || "";
      if (
        next.ip === previousIp &&
        next.from === selectedDate.value &&
        next.to === selectedEndDate.value &&
        next.sort === ipSort.value &&
        next.ipOrder === ipOrder.value &&
        next.requestOrder === requestOrder.value &&
        next.mode === viewMode.value
      )
        return;
      invalidateRequest();
      loadError.value = false;
      selectedLogEntryKeys.value = new Set();
      resetCursorPagination();
      detailRequests.value = null;
      if (
        !next.ip &&
        previousIp &&
        overviewSnapshot &&
        next.mode === "ips" &&
        next.from === overviewSnapshot.filters.date &&
        next.to === overviewSnapshot.filters.endDate &&
        next.sort === overviewSnapshot.filters.sort &&
        next.ipOrder === overviewSnapshot.filters.order
      ) {
        openedFromOverview = false;
        viewMode.value = "ips";
        const { filters, groups, page } = overviewSnapshot;
        selectedDate.value = filters.date;
        selectedEndDate.value = filters.endDate;
        searchQuery.value = filters.search;
        selectedStatus.value = filters.status;
        selectedLoggedIn.value = filters.loggedIn;
        selectedCredential.value = filters.credential;
        selectedWAFStatus.value = filters.waf;
        limit.value = filters.limit;
        ipSort.value = filters.sort;
        ipOrder.value = filters.order;
        requestOrder.value = filters.requestOrder;
        ipGroups.value = groups;
        ipPage.value = page;
        trackIps(groups?.items.map((item) => item.client_ip) ?? []);
        await syncDateQuery();
        return;
      }
      selectedDate.value = next.from;
      selectedEndDate.value = next.to;
      ipSort.value = next.sort;
      ipOrder.value = next.ipOrder;
      requestOrder.value = next.requestOrder;
      viewMode.value = next.mode;
      ipPage.value = 1;
      if (
        next.ip &&
        overviewSnapshot &&
        JSON.stringify(filtersSnapshot()) ===
          JSON.stringify(overviewSnapshot.filters)
      ) {
        detailRequests.value =
          overviewSnapshot.groups?.items.find(
            (item) => (item.client_ip || "unknown") === next.ip,
          )?.requests ?? null;
      }
      await fetchEntries();
    },
  );
  const loadPage = async (
    direction: "first" | "newer" | "older",
    loadEntries: () => boolean,
  ) => {
    if (context.loading.value) return;
    selectedLogEntryKeys.value = new Set();
    if (isIpOverview.value) {
      if (
        direction === "older" &&
        ipPage.value * Number(limit.value) >= (ipGroups.value?.total ?? 0)
      )
        return;
      if (direction === "newer" && ipPage.value <= 1) return;
      ipPage.value =
        direction === "first"
          ? 1
          : ipPage.value + (direction === "older" ? 1 : -1);
      await fetchEntries();
    } else if (loadEntries()) await fetchEntries();
  };
  const invalidateOverview = (preserveView = false) => {
    openedFromOverview = false;
    overviewSnapshot = null;
    if (preserveView) return;
    detailRequests.value = null;
    ipGroups.value = null;
    ipPage.value = 1;
  };
  return {
    syncDateQuery,
    loadPage,
    viewMode,
    clientIp,
    isIpOverview,
    ipGroups,
    ipPage,
    ipSort,
    ipOrder,
    requestOrder,
    detailRequests,
    loadError,
    hasFilters,
    openIp,
    backToIps,
    showAllIpRequests,
    setViewMode,
    handleIpSortChange,
    handleOrderChange,
    invalidateOverview,
  };
};
