import type { Ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "@admin-shared/utils/toast";
import { isValidAnalyticsRange } from "../request-analysis/model";
import type {
  GatewayLoginFilterValue,
  GatewayStatusFilterValue,
  GatewayWAFFilterValue,
} from "./model";

export const useGatewayLogFilterActions = (context: {
  selectedDate: Ref<string>;
  selectedEndDate: Ref<string>;
  serverToday: Ref<string>;
  selectedStatus: Ref<GatewayStatusFilterValue>;
  selectedLoggedIn: Ref<GatewayLoginFilterValue>;
  selectedCredential: Ref<string>;
  selectedWAFStatus: Ref<GatewayWAFFilterValue>;
  limit: Ref<string>;
  applyFilter: (update: () => void) => Promise<void>;
}) => {
  const { t } = useI18n();
  const { applyFilter, selectedDate, selectedEndDate, serverToday } = context;
  const handleRangeChange = async (from: string, to: string) => {
    if (!isValidAnalyticsRange(from, to, serverToday.value)) {
      toast.error(t("admin.gatewayRequestLogs.range.invalid"));
      return;
    }
    await applyFilter(() => {
      selectedDate.value = from;
      selectedEndDate.value = to;
    });
  };
  const updateString =
    <T extends string>(field: Ref<T>) =>
    (value: unknown) =>
      value
        ? applyFilter(() => {
            field.value = String(value) as T;
          })
        : Promise.resolve();
  return {
    handleRangeChange,
    handleDateChange: (value: unknown) =>
      value
        ? handleRangeChange(String(value), String(value))
        : Promise.resolve(),
    handleSearch: () => applyFilter(() => undefined),
    handleStatusChange: updateString(context.selectedStatus),
    handleLoggedInChange: updateString(context.selectedLoggedIn),
    handleCredentialChange: updateString(context.selectedCredential),
    handleWAFStatusChange: updateString(context.selectedWAFStatus),
    handleLimitChange: updateString(context.limit),
  };
};
