import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { AcmeAPI } from "@/lib/api/acme";
import { DDNSAPI } from "@/lib/api/ddns";
import {
  buildDnsCredentialTransferSuggestion,
  resolveDnsCredentialBridges,
  type DnsCredentialTarget,
} from "@/lib/dns-credential-bridge";

type CredentialSource = {
  id: string;
  providerId: string;
  providerLabel: string;
  name: string;
  domain: string;
  credentials: Record<string, string>;
};

type UseDnsCredentialTransferOptions = {
  target: DnsCredentialTarget;
  providerId: Readonly<Ref<string>>;
  targetCredentials: Readonly<Ref<Record<string, string>>>;
  active?: Readonly<Ref<boolean>>;
};

export const useDnsCredentialTransfer = ({
  target,
  providerId,
  targetCredentials,
  active = ref(true),
}: UseDnsCredentialTransferOptions) => {
  const { t } = useI18n();
  const isLoadingSource = ref(false);
  const hasSourceError = ref(false);
  const sources = ref<CredentialSource[]>([]);
  const selectedSourceId = ref("");
  let requestId = 0;
  let disposed = false;
  const sourceScopeLabel = target === "acme" ? "DDNS" : "ACME";

  const refreshSource = async () => {
    const currentRequestId = ++requestId;
    const bridges = resolveDnsCredentialBridges(target, providerId.value);
    const isCurrent = () => !disposed && currentRequestId === requestId;
    sources.value = [];
    selectedSourceId.value = "";
    hasSourceError.value = false;
    isLoadingSource.value = false;
    if (disposed || !active.value || !bridges.length) return;
    isLoadingSource.value = true;
    try {
      if (target === "ddns") {
        const [applications, providers] = await Promise.all([
          AcmeAPI.getApplications(),
          AcmeAPI.dnsProviders(),
        ]);
        if (!isCurrent()) return;
        const supported = new Map(
          providers.map((item) => [item.dnsType, item.label]),
        );
        sources.value = applications
          .filter(
            (item) =>
              supported.has(item.dnsType) &&
              bridges.some((bridge) => bridge.acmeDnsType === item.dnsType),
          )
          .map((item) => ({
            id: item.id,
            providerId: item.dnsType,
            providerLabel: supported.get(item.dnsType)!,
            name: item.name?.trim() || item.primaryDomain,
            domain: item.domains.join(", "),
            credentials: item.credentials,
          }));
      } else {
        const list = await DDNSAPI.getTargets();
        if (!isCurrent()) return;
        const matches = list.items.filter((item) =>
          bridges.some((bridge) => bridge.ddnsProvider === item.provider),
        );
        const details = await Promise.allSettled(
          matches.map((item) => DDNSAPI.getTarget(item.id)),
        );
        if (!isCurrent()) return;
        hasSourceError.value = details.some(
          (result) => result.status === "rejected",
        );
        sources.value = details.flatMap((result) => {
          if (result.status !== "fulfilled") return [];
          const item = result.value;
          return [
            {
              id: item.id,
              providerId: item.provider || "",
              providerLabel: item.providerLabel,
              name: item.name,
              domain: item.domainSummary,
              credentials: item.config,
            },
          ];
        });
      }
    } catch {
      // Do not log request objects: they can contain credentials in response data.
      if (isCurrent()) hasSourceError.value = true;
    } finally {
      if (isCurrent()) isLoadingSource.value = false;
    }
  };

  const candidates = computed(() => {
    const items = sources.value.flatMap((source) => {
      const suggestion = buildDnsCredentialTransferSuggestion({
        target,
        providerId: providerId.value,
        sourceProviderId: source.providerId,
        sourceCredentials: source.credentials,
        targetCredentials: targetCredentials.value,
        translateBridgeLabel: t,
      });
      if (!suggestion) return [];
      const label = [
        sourceScopeLabel,
        source.providerLabel,
        source.name,
        source.domain,
      ]
        .filter((part, index, parts) => part && parts.indexOf(part) === index)
        .join(" · ");
      return [{ id: source.id, label, suggestion }];
    });
    return items.map((item) => {
      const duplicates = items.filter(
        (other) => other.id !== item.id && other.label === item.label,
      );
      const shortId = item.id.slice(-8);
      const displayId = duplicates.some(
        (other) => other.id.slice(-8) === shortId,
      )
        ? item.id
        : shortId;
      return {
        ...item,
        label: duplicates.length ? `${item.label} (${displayId})` : item.label,
      };
    });
  });
  const selectedSource = computed(() =>
    selectedSourceId.value
      ? candidates.value.find((item) => item.id === selectedSourceId.value)
      : candidates.value.length === 1
        ? candidates.value[0]
        : undefined,
  );
  const suggestion = computed(() => selectedSource.value?.suggestion ?? null);

  const applySuggestion = () => {
    const current = suggestion.value;
    if (
      !active.value ||
      isLoadingSource.value ||
      !current ||
      current.conflictingFields.length
    )
      return null;
    const patch = { ...current.patch };
    const appliedKeys = Object.keys(patch);
    if (!appliedKeys.length) return null;
    // Keep the chosen identity even when filling removes it from the candidates.
    // Another remaining source must never become selected as a side effect.
    selectedSourceId.value = selectedSource.value!.id;
    return { patch, appliedKeys, count: appliedKeys.length };
  };

  watch(
    [providerId, active],
    () => {
      void refreshSource();
    },
    { immediate: true, flush: "sync" },
  );
  onScopeDispose(() => {
    disposed = true;
    requestId++;
    sources.value = [];
  });
  return {
    applySuggestion,
    candidates,
    hasSourceError,
    isLoadingSource,
    refreshSource,
    selectedSource,
    selectedSourceId,
    sourceScopeLabel,
    suggestion,
  };
};
