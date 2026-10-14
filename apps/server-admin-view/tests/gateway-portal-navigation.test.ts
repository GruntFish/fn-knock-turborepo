import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveGatewayPortalTargetHref,
  usesGatewayPortalLanNavigation,
} from "../src/lib/gateway-portal-navigation";

describe("gateway portal navigation", () => {
  it("lets smart detection override the manual mode and fails closed for unknown clients", () => {
    for (const navigation_mode of ["internet", "lan"] as const) {
      for (const clientIsLan of [true, false, null, undefined]) {
        assert.equal(
          usesGatewayPortalLanNavigation(
            { navigation_mode, smart_lan_detection: true },
            clientIsLan,
          ),
          clientIsLan === true,
        );
        assert.equal(
          usesGatewayPortalLanNavigation(
            { navigation_mode, smart_lan_detection: false },
            clientIsLan,
          ),
          navigation_mode === "lan",
        );
      }
    }
    assert.equal(usesGatewayPortalLanNavigation(undefined, true), false);
  });

  it("preserves target ports, paths, queries and fragments for browser-navigable targets", () => {
    for (const target of [
      "http://192.168.1.10:8080/base?tab=1&view=all",
      "https://[fd00::10]:9443/a%20b?tab=1#details",
      "http://nas.internal:5000/app/",
      "http://my_nas.internal:5000/app/",
      "http://100.64.1.2:8080/",
      "http://[::ffff:192.168.1.10]:8080/",
      "http://[fe8::1]:8080/",
      "http://[ff::1]:8080/",
      "http://bücher.example:5000/app/",
    ])
      assert.equal(
        resolveGatewayPortalTargetHref(target),
        new URL(target).href,
        target,
      );
    assert.equal(
      resolveGatewayPortalTargetHref("  http://nas.internal:5000/  "),
      "http://nas.internal:5000/",
    );
  });

  for (const target of [
    "",
    undefined,
    "http://localhost:3000",
    "http://LOCALHOST./",
    "http://app.localhost/",
    "http://ｌｏｃａｌｈｏｓｔ/",
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://192.168.1/",
    "http://0300.0250.1.10/",
    "http://[::1]/",
    "http://[0:0:0:0:0:0:0:1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://0.0.0.0/",
    "http://[::]/",
    "http://[::ffff:0.0.0.0]/",
    "http://169.254.1.1/",
    "http://[fe80::1]/",
    "http://[febf::1]/",
    "http://[fe80::1%25eth0]/",
    "http://224.0.0.1/",
    "http://239.255.255.255/",
    "http://[ff02::1]/",
    "http://[::ffff:224.0.0.1]/",
    "http://nas:0/",
    "http://nas:65536/",
    "http://nas:bad/",
    "http://user:pass@nas/",
    "http://@nas/",
    "javascript:alert(1)",
    "//nas:8080/",
    "/relative",
    "ws://nas/",
    "http:///nas/",
    "http://fd00::1:8080/",
    "http://[192.168.1.1]/",
    "http://nas/a b",
    "http://nas/\tb",
    "http://nas/path\u0000",
    "http://nas\\evil/",
    "http://bad..name/",
    "http://%6cocalhost/",
    "http://nas%2einternal/",
    `http://${"a".repeat(64)}.internal/`,
  ])
    it(`falls back for unsafe or non-navigable target ${String(target)}`, () => {
      assert.equal(resolveGatewayPortalTargetHref(target), "");
    });
});
