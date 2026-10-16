import { mount } from "@vue/test-utils";
import { computed, defineComponent, h } from "vue";
import { createI18n } from "vue-i18n";
import { describe, expect, it } from "vitest";
import ProxyTargetInputField from "@admin-shared/components/common/ProxyTargetInputField.vue";
import { useProxyMappingDialogForm } from "@admin-shared/composables/useProxyMappingDialogForm";
import {
  isSupportedProxyTargetUrl,
  isWebSocketProxyTargetUrl,
  normalizeProxyTargetInput,
  PROXY_TARGET_PROTOCOLS,
} from "@admin-shared/utils/proxyTargetInput";
import { isMappingDraftValid } from "../src/views/subdomain-proxy/subdomain-mapping-model";

const isHostDraftValid = (target: string) =>
  isMappingDraftValid({
    basicAuthValidationMessage: "",
    canUseRootDomainSuffix: false,
    host: "music.example.com",
    inputMode: "full_host",
    staticServeValidationIssue: null,
    target,
    targetType: "proxy",
  });

describe("proxy target validation", () => {
  it("rejects path-only targets in the reverse proxy form", () => {
    const { form, isValid } = useProxyMappingDialogForm({
      rewrite_html: false,
      use_auth: true,
      use_root_mode: false,
      strip_path: false,
    });
    form.path = "/music";
    form.target = "http:///music/";
    expect(isValid.value).toBe(false);
    form.target = "http://localhost:8080/music/";
    expect(isValid.value).toBe(true);
  });

  it.each(PROXY_TARGET_PROTOCOLS)(
    "rejects path-only targets for %s before and after blur normalization",
    (protocol) => {
      const target = `${protocol}:///music/`;
      expect(isSupportedProxyTargetUrl(target)).toBe(false);
      expect(isWebSocketProxyTargetUrl(target)).toBe(false);
      expect(isHostDraftValid(target)).toBe(false);
      expect(normalizeProxyTargetInput(protocol, "/music/").target).toBe(
        target,
      );
    },
  );

  it.each([
    "",
    "/music/",
    "http:music/",
    "http:/music/",
    "http:/music://host",
    "http:music://host",
    "http://./music/",
    "http://../music/",
    "http:////music/",
    "http://?query=music",
    "http://#music",
    "http://\\music/",
    "http://local\nhost/music/",
    "http://localhost:",
    "http://localhost:abc",
    "http://localhost:65536",
    "ftp://localhost/music/",
  ])("rejects malformed target %j", (target) => {
    expect(isSupportedProxyTargetUrl(target)).toBe(false);
  });

  it.each([
    "http://127.0.0.1:8080/music/",
    "https://nas.local/music/",
    "http://localhost/music/",
    "ws://[::1]:8080/socket",
    "wss://example.com/socket?token=abc",
    "http://service:3000/a%20b",
  ])("preserves valid upstream %s", (target) => {
    expect(isSupportedProxyTargetUrl(target)).toBe(true);
    expect(isHostDraftValid(target)).toBe(true);
  });

  it.each(PROXY_TARGET_PROTOCOLS)(
    "still fills the default port for a valid %s target",
    (protocol) => {
      const port = protocol === "https" || protocol === "wss" ? "443" : "80";
      expect(
        normalizeProxyTargetInput(protocol, "localhost/music/").target,
      ).toBe(`${protocol}://localhost:${port}/music/`);
    },
  );

  it("shows an accessible error and blocks saving until the target is corrected", async () => {
    const errorMessage =
      "Enter an IP address or hostname; a path alone is not valid.";
    const Harness = defineComponent({
      setup() {
        const { form, isValid } = useProxyMappingDialogForm({
          rewrite_html: false,
          use_auth: true,
          use_root_mode: false,
          strip_path: false,
        });
        form.path = "/music";
        const canSave = computed(
          () => isValid.value && isHostDraftValid(form.target),
        );
        return () =>
          h("div", [
            h(ProxyTargetInputField, {
              modelValue: form.target,
              "onUpdate:modelValue": (value: string) => {
                form.target = value;
              },
            }),
            h("button", { disabled: !canSave.value }, "Save"),
          ]);
      },
    });
    const wrapper = mount(Harness, {
      global: {
        plugins: [
          createI18n({
            legacy: false,
            locale: "en",
            messages: {
              en: {
                shared: {
                  proxyTargetInputField: {
                    hint: "Enter the target",
                    invalidTarget: errorMessage,
                    suggestionsLabel: "Suggestions",
                  },
                },
              },
            },
          }),
        ],
      },
    });
    const input = wrapper.get("input");
    const saveButton = () => wrapper.get('button:not([role="combobox"])');
    expect(saveButton().attributes("disabled")).toBeDefined();
    await input.setValue("/music/");
    expect(input.attributes("aria-invalid")).toBe("true");
    expect(wrapper.get("[role=alert]").text()).toBe(errorMessage);
    expect(input.attributes("aria-describedby")).toBe(
      wrapper.get("[role=alert]").attributes("id"),
    );
    expect(saveButton().attributes("disabled")).toBeDefined();
    await input.trigger("blur");
    expect(saveButton().attributes("disabled")).toBeDefined();
    expect((input.element as HTMLInputElement).value).toBe("/music/");
    await input.setValue("127.0.0.1:8080/music/");
    expect(input.attributes("aria-invalid")).toBe("false");
    expect(wrapper.find("[role=alert]").exists()).toBe(false);
    expect(saveButton().attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });
});
