{
  description = "Pi development shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    pi-src = {
      url = "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.78.0.tgz";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      pi-src,
    }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          nodejs = pkgs.nodejs_22;
        in
        rec {
          pi = pkgs.buildNpmPackage {
            pname = "pi";
            version = "0.78.0";

            src = pi-src;
            inherit nodejs;
            sourceRoot = "source";
            npmDepsFetcherVersion = 2;
            npmDepsHash = "sha256-iT20AoIOxLxJe09Q8uIA2SfXXREZpu/iK4rvwrIe4Qg=";
            npmInstallFlags = [
              "--omit=dev"
            ];
            postPatch = ''
              cp "$src/npm-shrinkwrap.json" npm-shrinkwrap.json
              substituteInPlace npm-shrinkwrap.json \
                --replace-fail '"resolved": "https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.78.0.tgz",' \
                                 '"resolved": "https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.78.0.tgz","integrity": "sha512-xhWd59Qzd8yO88gYQw2S4dEQstJJEiUtxRP01//YzVJ61jCtUASMfcyAmYhgGYR4Onp7GmwEAbBBGOiV6Iwk9g==",'
              substituteInPlace npm-shrinkwrap.json \
                --replace-fail '"resolved": "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.78.0.tgz",' \
                                 '"resolved": "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.78.0.tgz","integrity": "sha512-q0hUrvT6ngT6cgBX0oIbzfQfmzztgdkZobP8OTL+sCOOBlnG6+1YRt8g7zO9CC/4NdeYEqa7uGqWdQhH0fjCLA==",'
              substituteInPlace npm-shrinkwrap.json \
                --replace-fail '"resolved": "https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-0.78.0.tgz",' \
                                 '"resolved": "https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-0.78.0.tgz","integrity": "sha512-3a705FnsVVUhAyceShNB3kS2rpxcxLcx+hqB0u6MMMpHwQGbW+m++MqA6r7eOzq/8FLx5e3vDh38h/SVTk2qzw==",'
              cp npm-shrinkwrap.json package-lock.json
              substituteInPlace package.json \
                --replace-fail '"devDependencies": {
		"@types/cross-spawn": "6.0.6",
		"@types/diff": "7.0.2",
		"@types/hosted-git-info": "3.0.5",
		"@types/ms": "2.1.0",
		"@types/node": "24.12.4",
		"@types/proper-lockfile": "4.1.4",
		"shx": "0.4.0",
		"typescript": "5.9.3",
		"vitest": "3.2.4"
	},' \
                                 '"devDependencies": {},'
            '';

            dontCheck = true;
            dontNpmBuild = true;

            meta = {
              description = "Pi coding agent CLI";
              homepage = "https://pi.dev/docs/latest";
              mainProgram = "pi";
              license = lib.licenses.mit;
              platforms = lib.platforms.unix;
            };
          };

          default = pi;
        }
      );

      apps = forAllSystems (
        system:
        {
          default = {
            type = "app";
            program = "${self.packages.${system}.pi}/bin/pi";
          };
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = [
              self.packages.${system}.pi
              pkgs.nodejs_22
              pkgs.pnpm
            ];
          };
        }
      );
    };
}
