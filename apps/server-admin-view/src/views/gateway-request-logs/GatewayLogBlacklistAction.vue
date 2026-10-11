<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Ban, Unlock } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import ConfirmDangerTooltip from "@/components/ConfirmDangerTooltip.vue";
const props = defineProps<{
  ip: string;
  blocked: boolean;
  mutating: boolean;
  block: (ips: string[]) => void | Promise<void>;
  release: (ips: string[]) => void | Promise<void>;
}>();
const { t } = useI18n();
const key = computed(() => (props.blocked ? "unblacklist" : "blacklist"));
</script>
<template>
  <ConfirmDangerTooltip
    :confirm-text="t('common.confirm')"
    :label="t(`admin.gatewayRequestLogs.${key}One`)"
    :title="t(`admin.gatewayRequestLogs.${key}OneTitle`)"
    :description="t(`admin.gatewayRequestLogs.${key}OneDescription`, { ip })"
    :disabled="!ip || mutating"
    :loading="mutating"
    :on-confirm="() => (blocked ? release([ip]) : block([ip]))"
  >
    <template #trigger>
      <Button
        variant="outline"
        size="sm"
        :disabled="!ip || mutating"
        :class="blocked ? '' : 'text-destructive'"
      >
        <Unlock v-if="blocked" class="mr-1 h-3.5 w-3.5" /><Ban
          v-else
          class="mr-1 h-3.5 w-3.5"
        />
        {{ t(`admin.gatewayRequestLogs.${key}One`) }}
      </Button>
    </template>
  </ConfirmDangerTooltip>
</template>
