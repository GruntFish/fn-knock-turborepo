import { ref } from "vue";
import { SystemAPI } from "@/lib/api/system";

interface UseAccessEntryPortOptions {
  fallbackPort?: string;
  onError?: (error: unknown) => void;
}

export function useAccessEntryPort({
  fallbackPort = "7999",
  onError = (error) => {
    console.warn("load access entry port failed:", error);
  },
}: UseAccessEntryPortOptions = {}) {
  const accessEntryPort = ref(fallbackPort);
  const isLoading = ref(false);
  const hasLoadError = ref(false);
  let requestId = 0;

  async function loadAccessEntryPort() {
    const currentRequest = ++requestId;
    isLoading.value = true;
    hasLoadError.value = false;
    if (!fallbackPort) accessEntryPort.value = "";
    try {
      const info = await SystemAPI.getAccessEntry();
      const port = info.port.trim();
      if (
        !/^\d{1,5}$/u.test(port) ||
        Number(port) < 1 ||
        Number(port) > 65535
      ) {
        throw new Error("Invalid access entry port");
      }
      if (currentRequest === requestId) accessEntryPort.value = port;
    } catch (error) {
      if (currentRequest !== requestId) return;
      hasLoadError.value = true;
      onError(error);
    } finally {
      if (currentRequest === requestId) isLoading.value = false;
    }
  }

  return {
    accessEntryPort,
    isLoading,
    hasLoadError,
    loadAccessEntryPort,
  };
}
