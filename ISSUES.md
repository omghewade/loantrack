# Issues faced

Real problems hit while building and running this project, written up in the order they happened.
The commands and outputs are from the build and test sessions on this machine.

## 1. Pods never started: images were not built for the cluster

**Symptom.** The first `./scripts/deploy.sh` printed, for both images:

```
Incorrect Usage: flag provided but not defined: -build-arg
error: flag provided but not defined: -build-arg
```

and then, after applying the manifests:

```
Waiting for deployment "backend" rollout to finish: 0 of 2 updated replicas are available...
error: timed out waiting for the condition
```

**Diagnosis.**
1. Re-read the script output: the two `minikube image build` lines had failed, but the script
   carried on, so the Deployments referenced `loantrack-backend:v1` / `loantrack-frontend:v1`
   images that did not exist in the cluster.
2. `minikube profile list` showed the cluster runtime is **containerd**, not docker.
   `minikube image build --build-opt=build-arg=...` is passed to BuildKit's `buildctl` on
   containerd, which does not accept that flag.
3. `set -e` did not stop the script because `minikube image build` exited 0 despite the error.

**Root cause.** Image build step relied on a minikube feature that behaves differently per runtime,
and its failure was silent.

**Fix.** Build with the local Docker engine (`docker build --build-arg ...`, which fails loudly
under `set -e`) and copy the image in with `minikube image load`. Deploy then rolled out normally.

## 2. Frontend in CrashLoopBackOff after the cluster restarted

**Symptom.** After minikube restarted, both frontend pods showed `RESTARTS 5` and the events showed:

```
Warning   Unhealthy   pod/frontend-...   Readiness probe failed: ... connect: connection refused
Warning   BackOff     pod/frontend-...   Back-off restarting failed container frontend
```

**Diagnosis.**
1. `kubectl -n loantrack get pods` - frontend restarting, backend and postgres fine.
2. `kubectl -n loantrack logs deploy/frontend --previous`:
   ```
   nginx: [emerg] host not found in upstream "backend" in /etc/nginx/conf.d/default.conf:27
   ```
3. `kubectl -n kube-system get pods` - CoreDNS had restarted at the same moment as everything else.

**Root cause.** `proxy_pass http://backend:8000/;` makes nginx resolve the name **once, at
startup**, and refuse to start if it cannot. When the node restarts, the frontend can start before
CoreDNS is serving, so nginx exits and the kubelet backs off.

**Fix.** Resolve per request instead: `resolver ${NGINX_LOCAL_RESOLVERS} valid=10s;` (filled from
`/etc/resolv.conf` by the nginx image when `NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1`), a variable in
`proxy_pass`, and a fully-qualified `BACKEND_URL` because nginx's resolver ignores search domains.
Verified by scaling CoreDNS to 0 and restarting the frontend: pods stayed `Running` with 0 restarts,
`/api` returned `502` until DNS came back, then recovered on its own.

## 3. Every kubectl command refused after a few minutes idle

**Symptom.** Between two sessions, all commands failed with:

```
The connection to the server 127.0.0.1:32771 was refused - did you specify the right host or port?
```

and right after the cluster came back, a DNS check from a backend pod failed with
`socket.gaierror: [Errno -3] Temporary failure in name resolution`.

**Diagnosis.**
1. `minikube status` - `host: Stopped`.
2. `docker ps -a` - the `minikube` container had exited although nobody stopped it; the Compose
   containers (with `restart: unless-stopped`) were back up.
3. WSL2 shuts a distro down a few seconds after its last process exits. Every command was being
   run as a short `wsl -- ...` call, so the distro (and dockerd) stopped in between, and the
   minikube node container has no restart policy.
4. The DNS failure was a separate, timing issue: the check ran while CoreDNS was still restarting.
   `kubectl -n kube-system logs -l k8s-app=kube-dns` a minute later showed it answering
   `postgres.loantrack.svc.cluster.local` normally.

**Root cause.** Environment, not manifests: the WSL distro was idling out.

**Fix.** Keep a long-running process in the distro while working (an open Ubuntu terminal is
enough), run `minikube start` after a WSL restart, and wait for `kubectl -n kube-system rollout status
deployment/coredns` before testing DNS. Issue 2's fix also means the frontend now survives this.

## Smaller ones

- **Re-running `deploy.sh` restarted pods every time.** I stamp pod templates with a build hash so
  a rebuilt `:v1` image is picked up. Using the Docker image ID as the hash failed: with Docker's
  containerd image store the ID changed on every fully cached build. Hashing the build-input files
  instead made re-runs a no-op (`deployment.apps/backend patched (no change)`).
- **Page wider than the phone screen.** A `1fr` grid track grows to its content's min-content
  width, so the 640 px table pushed every card off-screen. `minmax(0, 1fr)` + `min-width: 0`.
- **City bars collapsed and regrew every 10 s** because they were rebuilt at 0 % width on each
  refresh; they now start from their previous width.
