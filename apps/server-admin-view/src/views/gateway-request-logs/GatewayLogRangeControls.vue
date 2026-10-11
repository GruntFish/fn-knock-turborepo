<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  isValidAnalyticsRange,
  resolveAnalyticsRange,
  REQUEST_ANALYTICS_RANGE_OPTIONS,
} from "../request-analysis/model";
const props = defineProps<{ from: string; to: string; today: string }>();
const emit = defineEmits<{ change: [from: string, to: string] }>();
const { t } = useI18n();
const draftFrom = ref(props.from);
const draftTo = ref(props.to);
watch(
  () => [props.from, props.to],
  () => {
    draftFrom.value = props.from;
    draftTo.value = props.to;
  },
);
const valid = computed(() =>
  isValidAnalyticsRange(draftFrom.value, draftTo.value, props.today),
);
const apply = () => {
  if (valid.value) emit("change", draftFrom.value, draftTo.value);
};
</script>
<template>
  <div
    class="grid w-full grid-cols-2 items-end gap-2 sm:flex sm:w-auto sm:flex-wrap"
  >
    <label class="min-w-0 space-y-1 text-xs text-muted-foreground">
      <span class="block">{{ t("admin.gatewayRequestLogs.range.from") }}</span>
      <Input
        v-model="draftFrom"
        type="date"
        :max="today"
        class="w-full sm:w-40"
      />
    </label>
    <label class="min-w-0 space-y-1 text-xs text-muted-foreground">
      <span class="block">{{ t("admin.gatewayRequestLogs.range.to") }}</span>
      <Input
        v-model="draftTo"
        type="date"
        :min="draftFrom"
        :max="today"
        class="w-full sm:w-40"
      />
    </label>
    <div class="col-span-2 flex flex-wrap items-center gap-1">
      <Button variant="outline" :disabled="!valid" @click="apply">{{
        t("admin.gatewayRequestLogs.range.apply")
      }}</Button>
      <Button
        v-for="option in REQUEST_ANALYTICS_RANGE_OPTIONS"
        :key="option.key"
        variant="ghost"
        size="sm"
        @click="
          emit('change', resolveAnalyticsRange(option.key, today).from, today)
        "
        >{{ t(option.labelKey) }}</Button
      >
    </div>
    <p
      v-if="!valid"
      role="alert"
      class="col-span-2 w-full text-xs text-destructive"
    >
      {{ t("admin.gatewayRequestLogs.range.invalid") }}
    </p>
  </div>
</template>
