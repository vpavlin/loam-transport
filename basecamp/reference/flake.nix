# scala_core build inputs — pins the CHANNELS-enabled delivery_module + the module
# builder to the SAME revs KYM/qaku use, so scala builds against one SDK (no IPC skew)
# and interops on the wire. Copy to scala_core/flake.nix.
#
# NOTE: delivery_module is on the feat-add-channel-api-support BRANCH — branches can be
# renamed/deleted (a from-scratch eval then 422s). Prefer pinning the full rev below.
# Known-good (2026-08, from KYM's flake.lock):
#   logos-module-builder  afe4430ee6eb7ba45c08a516a43e18500720c715
#   delivery_module       0fb3a7427b29c98ab0fa2465bcd1e90cbfdf50a3  (channels API)
{
  description = "scala engine + sync CORE module (delivery via the shared logos-transport).";
  inputs = {
    delivery_module.url = "github:logos-co/logos-delivery-module/0fb3a7427b29c98ab0fa2465bcd1e90cbfdf50a3";
    logos-module-builder.url = "github:logos-co/logos-module-builder/afe4430ee6eb7ba45c08a516a43e18500720c715";
    delivery_module.inputs.logos-module-builder.follows = "logos-module-builder";
  };
  # mkLogosModule (headless core, no QML) — plugin glue generated from src/scala_core_impl.h.
  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}
