import { useI18n } from "vue-i18n";
import {
  extractErrorMessage,
  useAsyncAction,
} from "@admin-shared/composables/useAsyncAction";
import { toast } from "@admin-shared/utils/toast";
import { GatewayLogsAPI } from "@/lib/api/gateway";

export const useGatewayLogDeletion = () => {
  const { t } = useI18n();
  const { isPending: isDeleting, run } = useAsyncAction({
    onError: (error) => {
      toast.error(t("admin.gatewayRequestLogs.deleteFailed"), {
        description: extractErrorMessage(
          error,
          t("admin.gatewayRequestLogs.deleteFailedDescription"),
        ),
      });
    },
  });
  const deleteDate = (
    date: string,
    onDeleted: (
      data: Awaited<ReturnType<typeof GatewayLogsAPI.deleteDate>>,
    ) => Promise<void>,
  ) =>
    run(() => GatewayLogsAPI.deleteDate(date), {
      onSuccess: async (data) => {
        toast.success(
          t(
            data.deleted
              ? "admin.gatewayRequestLogs.deletedForDate"
              : "admin.gatewayRequestLogs.noDeletedForDate",
            { date },
          ),
        );
        await onDeleted(data);
      },
    });
  return { isDeleting, deleteDate };
};
