#!/bin/sh
set -eu

agent_site=$(/opt/agent-venv/bin/python -c 'import site; print(site.getsitepackages()[0])') \
  && grep -Fx '    urllib3==2.7.0' "$agent_site/pip/_vendor/vendor.txt" \
  && grep -Fx 'msgpack==1.1.2' "$agent_site/pip/_vendor/vendor.txt" \
  && grep -Fx 'setuptools==70.3.0' "$agent_site/pip/_vendor/vendor.txt" \
  && jq -e \
      '([.components[] | select(.name == "msgpack" and .version == "1.1.2" and .purl == "pkg:pypi/msgpack@1.1.2")] | length) == 1 and ([.components[] | select(.name == "setuptools" and .version == "70.3.0" and .purl == "pkg:pypi/setuptools@70.3.0")] | length) == 1 and ([.components[] | select(.name == "urllib3" and .version == "2.7.0" and .purl == "pkg:pypi/urllib3@2.7.0")] | length) == 1' \
      "$agent_site/pip/_vendor/bom.cdx.json" \
  && /opt/agent-venv/bin/pip install --no-cache-dir --no-deps --target /tmp/pip-vendor-fix \
      msgpack==1.2.3 \
      setuptools==78.1.1 \
      urllib3==2.8.0 \
  && sed -i \
      -e 's/^import packaging\./from pip._vendor import packaging\nfrom pip._vendor.packaging import /' \
      -e 's/^from jaraco\.text import /from pip._internal.utils._jaraco_text import /' \
      -e 's/^from platformdirs import /from pip._vendor.platformdirs import /' \
      /tmp/pip-vendor-fix/pkg_resources/__init__.py \
  && rm -rf "$agent_site/pip/_vendor/msgpack" "$agent_site/pip/_vendor/pkg_resources" "$agent_site/pip/_vendor/urllib3" \
  && cp -a \
      /tmp/pip-vendor-fix/msgpack \
      /tmp/pip-vendor-fix/pkg_resources \
      /tmp/pip-vendor-fix/urllib3 \
      "$agent_site/pip/_vendor/" \
  && sed -i \
      -e 's/msgpack==1.1.2/msgpack==1.2.3/' \
      -e 's/setuptools==70.3.0/setuptools==78.1.1/' \
      -e 's/urllib3==2.7.0/urllib3==2.8.0/' \
      "$agent_site/pip/_vendor/vendor.txt" \
  && jq \
      '.components |= map(if .name == "msgpack" then .["bom-ref"] = "pkg:pypi/msgpack@1.2.3" | .purl = "pkg:pypi/msgpack@1.2.3" | .version = "1.2.3" elif .name == "setuptools" then .["bom-ref"] = "pkg:pypi/setuptools@78.1.1" | .purl = "pkg:pypi/setuptools@78.1.1" | .version = "78.1.1" elif .name == "urllib3" then .["bom-ref"] = "pkg:pypi/urllib3@2.8.0" | .purl = "pkg:pypi/urllib3@2.8.0" | .version = "2.8.0" else . end) | .dependencies |= map(if .ref == "pkg:pypi/msgpack@1.1.2" then .ref = "pkg:pypi/msgpack@1.2.3" elif .ref == "pkg:pypi/setuptools@70.3.0" then .ref = "pkg:pypi/setuptools@78.1.1" elif .ref == "pkg:pypi/urllib3@2.7.0" then .ref = "pkg:pypi/urllib3@2.8.0" else . end | if has("dependsOn") then .dependsOn |= map(if . == "pkg:pypi/msgpack@1.1.2" then "pkg:pypi/msgpack@1.2.3" elif . == "pkg:pypi/setuptools@70.3.0" then "pkg:pypi/setuptools@78.1.1" elif . == "pkg:pypi/urllib3@2.7.0" then "pkg:pypi/urllib3@2.8.0" else . end) else . end)' \
      "$agent_site/pip/_vendor/bom.cdx.json" > "$agent_site/pip/_vendor/bom.cdx.json.tmp" \
  && mv "$agent_site/pip/_vendor/bom.cdx.json.tmp" "$agent_site/pip/_vendor/bom.cdx.json" \
  && rm -rf /tmp/pip-vendor-fix \
  && grep -Fx '    urllib3==2.8.0' "$agent_site/pip/_vendor/vendor.txt" \
  && grep -Fx 'msgpack==1.2.3' "$agent_site/pip/_vendor/vendor.txt" \
  && grep -Fx 'setuptools==78.1.1' "$agent_site/pip/_vendor/vendor.txt" \
  && ! grep -Eq 'msgpack==1\.1\.2|setuptools==70\.3\.0|urllib3==2\.7\.0' "$agent_site/pip/_vendor/vendor.txt" \
  && jq -e \
      '([.components[] | select(.name == "msgpack" and .version == "1.2.3" and .purl == "pkg:pypi/msgpack@1.2.3")] | length) == 1 and ([.components[] | select(.name == "setuptools" and .version == "78.1.1" and .purl == "pkg:pypi/setuptools@78.1.1")] | length) == 1 and ([.components[] | select(.name == "urllib3" and .version == "2.8.0" and .purl == "pkg:pypi/urllib3@2.8.0")] | length) == 1 and ([.. | strings | select(. == "pkg:pypi/msgpack@1.1.2" or . == "pkg:pypi/setuptools@70.3.0" or . == "pkg:pypi/urllib3@2.7.0")] | length) == 0' \
      "$agent_site/pip/_vendor/bom.cdx.json" \
  && /opt/agent-venv/bin/python -c 'from pip._vendor import certifi, msgpack, pkg_resources, urllib3; assert certifi.__version__ == "2026.10.19"; assert urllib3.__version__ == "2.8.0"; assert msgpack.version == (1, 2, 3); assert str(pkg_resources.parse_version("1.2.3")) == "1.2.3"' \
  && /opt/agent-venv/bin/pip check \
  && /opt/agent-venv/bin/pip index versions pip \
  && /opt/agent-venv/bin/pip --version
