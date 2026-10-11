<script setup lang="ts">
import { useI18n } from "vue-i18n";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
defineProps<{ order: string }>();
const emit = defineEmits<{ change: [value: unknown] }>();
const { t } = useI18n();
</script>
<template>
  <Select :model-value="order" @update:model-value="emit('change', $event)">
    <SelectTrigger
      class="w-40"
      :aria-label="t('admin.gatewayRequestLogs.timeOrder.label')"
      ><SelectValue
    /></SelectTrigger>
    <SelectContent>
      <SelectItem value="desc">{{
        t("admin.gatewayRequestLogs.timeOrder.desc")
      }}</SelectItem>
      <SelectItem value="asc">{{
        t("admin.gatewayRequestLogs.timeOrder.asc")
      }}</SelectItem>
    </SelectContent>
  </Select>
</template>
