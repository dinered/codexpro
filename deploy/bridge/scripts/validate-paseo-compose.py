"""Compare live state with original Compose without logging environment values."""
import hashlib
import json
import os
import subprocess
import sys


def environment(values):
    return dict(value.split("=", 1) if "=" in value else (value, "") for value in values or [])


def validate(live, image, rendered):
    service = live["Config"]["Labels"]["com.docker.compose.service"]
    config = rendered["services"][service]
    expected_env = environment(image["Config"].get("Env"))
    for key, value in (config.get("environment") or {}).items():
        if value is None:
            expected_env.pop(key, None)
        else:
            expected_env[key] = str(value)
    if environment(live["Config"].get("Env")) != expected_env:
        raise ValueError("Live environment differs from original Compose/image; values withheld")
    for compose_key, docker_key in [("command", "Cmd"), ("entrypoint", "Entrypoint")]:
        expected = config.get(compose_key)
        if expected is None:
            expected = image["Config"].get(docker_key)
        if (live["Config"].get(docker_key) or []) != (expected or []):
            raise ValueError("Live " + compose_key + " differs from original Compose/image")
    # This installation supports the verified bind-mounted Paseo deployment only.
    expected_mounts = {}
    for mount in config.get("volumes", []):
        if mount.get("type") != "bind":
            raise ValueError("Non-bind mount needs separate preservation review")
        expected_mounts[mount["target"]] = (os.path.realpath(mount["source"]), not mount.get("read_only", False))
    actual_mounts = {}
    for mount in live.get("Mounts", []):
        if mount["Type"] != "bind":
            raise ValueError("Unexpected live non-bind mount needs review")
        actual_mounts[mount["Destination"]] = (os.path.realpath(mount["Source"]), mount["RW"])
    if expected_mounts != actual_mounts:
        raise ValueError("Live mounts differ from original Compose; paths/values withheld")
    return hashlib.sha256(json.dumps(rendered, sort_keys=True).encode()).hexdigest()


if __name__ == "__main__":
    try:
        container, image, *compose = sys.argv[1:]
        def read(command):
            return json.loads(subprocess.check_output(command))
        live = read(["docker", "inspect", container])[0]
        base = read(["docker", "image", "inspect", image])[0]
        if live["Image"] != image:
            raise ValueError("Running image changed")
        digest = validate(live, base, read(compose + ["config", "--format", "json"]))
        expected = os.environ.get("CODEXPRO_EXPECTED_CONFIG_HASH")
        if expected and digest != expected:
            raise ValueError("Rendered Compose changed during preparation")
        print(digest)  # captured by the installer; never print rendered credentials
    except (ValueError, KeyError, subprocess.CalledProcessError) as error:
        print("Preservation check failed: " + str(error), file=sys.stderr)
        sys.exit(1)
