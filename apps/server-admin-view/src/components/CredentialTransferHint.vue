<script setup lang="ts">
import { computed, toRef, useId } from "vue";
import { ArrowLeftRight } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDnsCredentialTransfer } from "@/composables/useDnsCredentialTransfer";
import type { DnsCredentialTarget } from "@/lib/dns-credential-bridge";
import { toast } from "@admin-shared/utils/toast";

const props = withDefaults(
  defineProps<{
    target: DnsCredentialTarget;
    providerId: string;
    credentials: Record<string, string>;
    active?: boolean;
    disabled?: boolean;
  }>(),
  { active: true, disabled: false },
);
const emit = defineEmits<{ apply: [patch: Record<string, string>] }>();
const { t } = useI18n();
const sourceId = useId();
const {
  applySuggestion,
  candidates,
  hasSourceError,
  isLoadingSource,
  refreshSource,
  selectedSource,
  selectedSourceId,
  sourceScopeLabel,
  suggestion,
} = useDnsCredentialTransfer({
  target: props.target,
  providerId: toRef(props, "providerId"),
  targetCredentials: toRef(props, "credentials"),
  active: toRef(props, "active"),
});
const visible = computed(
  () =>
    props.active &&
    (isLoadingSource.value ||
      hasSourceError.value ||
      candidates.value.length > 0),
);
const apply = () => {
  if (props.disabled) return;
  const result = applySuggestion();
  if (!result) return;
  emit("apply", result.patch);
  toast.success(
    t("shared.dnsCredentialBridge.applied", { count: result.count }),
  );
};
</script>

<template>
  <div
    v-if="visible"
    class="min-w-0 space-y-3 rounded-lg border border-border/80 bg-background/70 p-4 text-foreground"
    data-testid="credential-transfer"
  >
    <div class="flex items-center gap-2 text-sm font-medium">
      <ArrowLeftRight class="h-4 w-4 shrink-0" aria-hidden="true" />
      {{ t("shared.dnsCredentialBridge.title") }}
    </div>
    <p class="text-xs leading-relaxed text-muted-foreground">
      {{ t("shared.dnsCredentialBridge.description") }}
    </p>
    <p
      v-if="isLoadingSource"
      role="status"
      class="text-sm text-muted-foreground"
    >
      {{ t("shared.dnsCredentialBridge.loading") }}
    </p>
    <div
      v-if="hasSourceError"
      role="status"
      class="flex flex-wrap items-center gap-2"
    >
      <p class="text-sm text-muted-foreground">
        {{ t("shared.dnsCredentialBridge.loadError") }}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        :disabled="isLoadingSource || disabled"
        @click="refreshSource"
        >{{ t("shared.dnsCredentialBridge.retry") }}</Button
      >
    </div>
    <div
      v-if="candidates.length > 1 || (candidates.length && !selectedSource)"
      class="min-w-0 space-y-2"
    >
      <Label :for="sourceId">{{
        t("shared.dnsCredentialBridge.source")
      }}</Label>
      <Select
        :model-value="selectedSource?.id || ''"
        @update:model-value="selectedSourceId = String($event ?? '')"
        :disabled="disabled || isLoadingSource"
      >
        <SelectTrigger
          :id="sourceId"
          class="data-[size=default]:h-auto min-h-11 w-full min-w-0 whitespace-normal text-left *:data-[slot=select-value]:block *:data-[slot=select-value]:line-clamp-none *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:break-all"
        >
          <SelectValue
            :placeholder="t('shared.dnsCredentialBridge.chooseSource')"
          />
        </SelectTrigger>
        <SelectContent class="max-w-[calc(100vw-2rem)]">
          <SelectItem
            v-for="candidate in candidates"
            :key="candidate.id"
            :value="candidate.id"
            class="whitespace-normal break-all"
          >
            {{ candidate.label }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
    <p v-else-if="selectedSource" class="break-all text-sm">
      {{ selectedSource.label }}
    </p>
    <template v-if="suggestion">
      <div class="flex flex-wrap gap-1.5">
        <span
          v-for="field in suggestion.fillableFields"
          :key="field.targetKey"
          class="break-all rounded-md border bg-muted/35 px-2 py-0.5 font-mono text-xs text-muted-foreground"
          >{{ field.targetKey }}</span
        >
      </div>
      <p
        v-if="suggestion.conflictingFields.length"
        role="status"
        class="text-sm text-destructive"
      >
        {{
          t("shared.dnsCredentialBridge.conflict", {
            fields: suggestion.conflictingFields.join(", "),
          })
        }}
      </p>
    </template>
    <Button
      v-if="candidates.length"
      type="button"
      variant="outline"
      class="min-h-11 w-full sm:w-auto"
      :disabled="
        disabled ||
        isLoadingSource ||
        !suggestion ||
        !!suggestion.conflictingFields.length
      "
      @click="apply"
    >
      {{ t("shared.dnsCredentialBridge.fill", { source: sourceScopeLabel }) }}
    </Button>
  </div>
</template>
