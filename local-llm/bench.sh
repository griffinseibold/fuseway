#!/usr/bin/env bash
# Benchmarks a GGUF on this GPU with the same llama.cpp build homelab serves.
#   local-llm/bench.sh speed Qwen3.8-27B-UD-IQ3_XXS.gguf [extra llama-bench args]
#   local-llm/bench.sh fit   Qwen3.8-27B-UD-IQ3_XXS.gguf 32768 49152 65536
#   local-llm/bench.sh tools http://llm.localhost:8080/v1
# speed: prompt processing at 8K and 32K (what agent turns pay for) and generation.
# fit:   which context sizes load fully on the GPU with a q8_0 KV cache.
# tools: sends a request with a tools array and checks for a well-formed tool call.
# Stop the homelab llama-server first (or use LLM-free apps mode): both need the whole GPU.
set -euo pipefail
IMAGE="${IMAGE:-ghcr.io/ggml-org/llama.cpp:full-vulkan}"
MODELS="${MODELS_DIR:-$HOME/models}"
run() { docker run --rm --device /dev/dri -v "$MODELS:/models:ro" "$@"; }

case "${1:-}" in
  speed)
    model="$2"; shift 2
    run --entrypoint /app/llama-bench "$IMAGE" -m "/models/$model" -ngl 99 -fa 1 \
      -ctk q8_0 -ctv q8_0 -p 8192,32768 -n 128 -r 2 -o md "$@" ;;
  fit)
    model="$2"; shift 2
    vram_file="$(ls /sys/class/drm/card*/device/mem_info_vram_used | head -1)"
    vram_mib() { echo $(( $(cat "$vram_file") / 1048576 )); }
    trap 'docker rm -f llm-fit >/dev/null 2>&1 || true' EXIT
    for ctx in "$@"; do
      before="$(vram_mib)"
      # No --rm here, so the logs survive a failed load.
      docker run -d --name llm-fit --device /dev/dri -v "$MODELS:/models:ro" -p 127.0.0.1:8089:8080 --entrypoint /app/llama-server "$IMAGE" \
        -m "/models/$model" -ngl 99 -c "$ctx" -fa on -ctk q8_0 -ctv q8_0 --host 0.0.0.0 --port 8080 >/dev/null
      status=""
      for _ in $(seq 120); do
        if curl -sf 127.0.0.1:8089/health >/dev/null; then status="fits, model+KV use $(( $(vram_mib) - before )) MiB VRAM"; break; fi
        [ "$(docker inspect -f '{{.State.Running}}' llm-fit 2>/dev/null)" = true ] || break
        sleep 2
      done
      [ -n "$status" ] || status="does not fit: $(docker logs llm-fit 2>&1 | tail -1)"
      echo "ctx $ctx: $status"
      docker rm -f llm-fit >/dev/null 2>&1 || true
    done ;;
  tools)
    url="${2%/}"
    curl -s "$url/chat/completions" -H 'content-type: application/json' -d '{
      "messages": [{"role": "user", "content": "What is the weather in Paris? Use the tool."}],
      "tools": [{"type": "function", "function": {"name": "get_weather",
        "description": "Get the current weather for a city",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]
    }' | python3 -c 'import json, sys
r = json.load(sys.stdin)
calls = r["choices"][0]["message"].get("tool_calls") or []
ok = len(calls) == 1 and calls[0]["function"]["name"] == "get_weather" and "city" in json.loads(calls[0]["function"]["arguments"])
print("PASS" if ok else "FAIL", json.dumps(calls or r["choices"][0]["message"])[:300])
sys.exit(0 if ok else 1)' ;;
  *) sed -n '2,9p' "$0"; exit 2 ;;
esac
