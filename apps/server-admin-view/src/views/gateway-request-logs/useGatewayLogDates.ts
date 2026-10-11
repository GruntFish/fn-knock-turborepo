import { computed, ref, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { GatewayLogsAPI } from "@/lib/api/gateway";
import { toast } from "@admin-shared/utils/toast";
import { extractErrorMessage } from "@admin-shared/composables/useAsyncAction";
import { getTodayString } from "./model";

export const useGatewayLogDateState = (query: Record<string, unknown>) => {
  const selectedDate = ref(
    typeof query.log_from === "string"
      ? query.log_from
      : typeof query.log_date === "string"
        ? query.log_date
        : getTodayString(),
  );
  const selectedEndDate = ref(
    typeof query.log_to === "string" ? query.log_to : selectedDate.value,
  );
  const serverToday = ref(getTodayString());
  const rangeLabel = computed(() =>
    selectedDate.value === selectedEndDate.value
      ? selectedDate.value
      : `${selectedDate.value} – ${selectedEndDate.value}`,
  );
  return { selectedDate, selectedEndDate, serverToday, rangeLabel };
};

export const useGatewayLogDates = ({
  selectedDate,
  selectedEndDate,
  serverToday,
  availableDates,
  logsDir,
  currentRequest,
}: {
  selectedDate: Ref<string>;
  selectedEndDate: Ref<string>;
  serverToday: Ref<string>;
  availableDates: Ref<string[]>;
  logsDir: Ref<string>;
  currentRequest: () => () => boolean;
}) => {
  const { t } = useI18n();
  const applyDates = (dates: string[], preferred?: string) => {
    const date = preferred || selectedDate.value || getTodayString();
    availableDates.value = [...new Set([...dates, date])].sort().reverse();
    selectedDate.value = date;
  };

  const fetchDates = async (preferred?: string) => {
    const isCurrent = currentRequest();
    try {
      const data = await GatewayLogsAPI.getDates();
      if (!isCurrent()) return;
      logsDir.value = data.logs_dir || "";
      serverToday.value = data.today || serverToday.value;
      if (!preferred) selectedEndDate.value = data.today || selectedDate.value;
      applyDates(
        data.dates || [],
        preferred || data.today || selectedDate.value,
      );
    } catch (error) {
      if (isCurrent()) {
        toast.error(t("admin.gatewayRequestLogs.loadFailed"), {
          description: extractErrorMessage(error),
        });
        applyDates(availableDates.value, preferred);
      }
    }
  };

  return { applyDates, fetchDates };
};
