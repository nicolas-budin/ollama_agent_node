# Pipeline Tekton de CD (OpenShift Pipelines sur CRC)

Ce guide couvre toute la procédure, d'un Mac sans rien d'installé jusqu'à l'appli en ligne sur le cluster OpenShift local (CRC), puis les déploiements suivants. L'appli est déployée dans le namespace `ollama-agent-node` par un pipeline Tekton.

## Vue d'ensemble

```
 Mac
 ├─ Ollama (gemma4:26b), exposé sur le réseau local ◄──────────────┐
 └─ VM CRC (OpenShift)                                             │ OLLAMA_URL
     └─ namespace ollama-agent-node                                │ (IP LAN du Mac)
         ├─ Pipeline ollama-agent-node                             │
         │    1. fetch-source  git clone de GitHub → COMMIT        │
         │    2. test          typecheck + tests back + front      │
         │    3. build-image   buildah → registre interne          │
         │                     ollama-agent-node:<COMMIT>          │
         │    4. deploy        Service + Route + Deployment        │
         │                     (image@digest)                      │
         └─ Pod ollama-agent-node ◄── Service ◄── Route ◄── navigateur
```

Deux points à garder en tête :

- Le pipeline se lance **à la main**. CRC n'est pas joignable depuis Internet, donc GitHub ne peut pas lui envoyer de webhook.
- Le pipeline **clone GitHub, pas ton dossier local** : il faut pousser sur `main` avant chaque lancement.

## Fichiers

| Fichier | Rôle |
|---|---|
| `tekton/operator-subscription.yaml` | Installe l'opérateur OpenShift Pipelines (une fois, en administrateur) |
| `tekton/workspace-pvc.yaml` | Volume `pipeline-source`, dossier de travail partagé par les tâches, réutilisé à chaque run |
| `tekton/pipeline.yaml` | Le pipeline (4 tâches) |
| `tekton/pipelinerun.yaml` | Modèle pour lancer un run |
| `openshift/deployment.yaml` | Deployment de l'appli (image remplacée par le pipeline) |
| `openshift/service.yaml`, `openshift/route.yaml` | Exposition de l'appli |

Les fichiers `tekton/` s'appliquent à la main pendant l'installation (étapes 5 et 8). Les fichiers `openshift/`, **jamais** : voir ci-dessous.

## Les manifestes `openshift/`

### Qui les applique : le pipeline, pas toi

Les trois fichiers décrivent l'appli telle qu'elle doit tourner sur le cluster :

| Fichier | Ce qu'il crée |
|---|---|
| `deployment.yaml` | Le pod de l'appli : image, `OLLAMA_URL`, sondes de santé, mémoire, 1 seule réplique |
| `service.yaml` | Une adresse interne stable vers le pod (port 8124) |
| `route.yaml` | L'adresse publique `http://ollama-agent-node-ollama-agent-node.apps-crc.testing`, avec un timeout de 5 min |

Tu n'as **aucune commande à lancer** avec ces fichiers. À chaque run, la dernière tâche du pipeline (`deploy`) :

1. applique `service.yaml` et `route.yaml` ;
2. remplace `IMAGE_PLACEHOLDER` dans `deployment.yaml` par l'image qu'elle vient de construire (`…/ollama-agent-node@sha256:<digest>`), puis applique le résultat ;
3. attend que le nouveau pod soit prêt (`oc rollout status`).

Le pipeline lit ces fichiers **dans Git**, dans le commit qu'il vient de cloner, et non dans ton dossier local.

### Ne pas faire `oc apply -f openshift/deployment.yaml`

Dans le fichier, l'image vaut littéralement `IMAGE_PLACEHOLDER`, et seul le pipeline sait par quoi la remplacer. Appliqué à la main, le fichier remplacerait l'image du Deployment par ce texte : le nouveau pod échouerait en `InvalidImageName` et l'appli serait coupée.

Si c'est arrivé, relancer un run (étape 9) remet la bonne image. `oc rollout undo deployment/ollama-agent-node -n ollama-agent-node` aussi, plus rapidement.

Pour `service.yaml` et `route.yaml`, un `oc apply` manuel ne casse rien, mais il est inutile.

### Les modifier

Pour changer la configuration de l'appli, modifier le fichier, pousser, puis relancer un run :

```bash
# ex. nouvelle IP d'Ollama dans openshift/deployment.yaml
git commit -am "config: nouvelle IP d'Ollama" && git push origin main
oc create -f tekton/pipelinerun.yaml -n ollama-agent-node
```

Ce qu'on peut y changer sans risque :

- **`deployment.yaml`**
  - `OLLAMA_URL` (IP du Mac) ;
  - ajouter `OLLAMA_MODEL` ou `OLLAMA_IDLE_TIMEOUT_MS` dans `env` (voir le [README principal](../README.md#variables-denvironnement)) ;
  - `resources` (mémoire, CPU).
- **`route.yaml`** : le timeout `haproxy.router.openshift.io/timeout`, si les réponses dépassent 5 minutes.

À ne pas changer :

- **`IMAGE_PLACEHOLDER`**, que le pipeline cherche et remplace.
- **Les noms**, `ollama-agent-node` partout : la tâche `deploy` attend ce nom de Deployment et de Route.
- **`replicas: 1` et `strategy: Recreate`** : l'historique de conversation vit en mémoire du pod, donc deux pods donneraient deux conversations différentes.
- **Le port 8124**, sauf à le changer aussi dans le `Dockerfile`, `service.yaml` et `route.yaml`.

Si tu supprimes une ressource de ces fichiers, le pipeline ne la supprime pas du cluster, car `oc apply` ne supprime rien. Il faut alors faire `oc delete` à la main.

---

## Étape 1 — Prérequis sur le Mac

### 1.0 Matériel

Le modèle et le cluster tournent tous les deux sur le Mac :

| Composant | Mémoire |
|---|---|
| Ollama + `gemma4:26b` | ~18 Go |
| VM CRC (OpenShift + Tekton + builds) | 16 Go (réglage ci-dessous) |
| macOS, navigateur, IDE | ~8 Go |

Il faut donc un Mac avec **au moins 48 Go de RAM**, et environ 150 Go de disque libre (CRC environ 100 Go, le modèle environ 17 Go, les caches). En dessous, le Mac swappe et les builds ou les réponses du modèle deviennent très lents, voire échouent.

### 1.1 CRC (OpenShift local)

1. Télécharger CRC et le *pull secret* sur <https://console.redhat.com/openshift/create/local> (compte Red Hat gratuit).
2. Installer le `.pkg`, puis :

   ```bash
   crc config set memory 16384     # 16 Go : OpenShift + Tekton + builds
   crc config set disk-size 100    # les images de build prennent de la place
   crc setup
   crc start                       # demande le pull secret au premier lancement
   crc status                      # → OpenShift: Running
   ```

3. Mettre la CLI `oc` fournie par CRC dans le PATH (à refaire dans chaque nouveau terminal, ou à ajouter dans `~/.zshrc`) :

   ```bash
   eval $(crc oc-env)
   oc version
   ```

La console web s'ouvre avec `crc console` (adresse : <https://console-openshift-console.apps-crc.testing>).

### 1.2 Ollama

```bash
brew install --cask ollama      # ou télécharger l'app sur https://ollama.com
ollama pull gemma4:26b
ollama list                     # → gemma4:26b
```

### 1.3 Le dépôt

```bash
git clone https://github.com/nicolas-budin/ollama_agent_node.git
cd ollama_agent_node
```

Toutes les commandes suivantes se lancent depuis la racine du dépôt.

Facultatif : la CLI Tekton rend le suivi des runs plus lisible (`brew install tektoncd-cli`).

## Étape 2 — Rendre Ollama joignable depuis le cluster

Par défaut, Ollama n'écoute que sur `localhost`. Le pod qui tourne dans la VM CRC doit pouvoir le joindre par l'IP du Mac sur le réseau local.

1. Exposer Ollama sur le réseau, au choix :
   - app Ollama : Settings → activer **« Expose Ollama to the network »** ;
   - ou en ligne de commande : `launchctl setenv OLLAMA_HOST 0.0.0.0`, puis quitter et relancer l'app Ollama.
2. Relever l'IP LAN du Mac :

   ```bash
   ipconfig getifaddr en0 || ipconfig getifaddr en1     # ex. 192.168.1.119
   ```

3. Vérifier depuis le Mac qu'Ollama répond sur cette IP (remplacer `192.168.1.119` par la tienne, ici comme dans toute la suite) :

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://192.168.1.119:11434/api/tags   # → 200
   ```

> **Sécurité.** Ollama n'a pas d'authentification. Une fois exposé, **n'importe quel appareil du même réseau** peut utiliser le modèle et lister ou supprimer les modèles installés. À ne faire que sur un réseau de confiance (maison), pas sur un Wi-Fi public ou d'entreprise.
>
> En dehors de ce cas, désactiver l'exposition (Settings, ou `launchctl unsetenv OLLAMA_HOST` puis relancer l'app), ou activer le pare-feu macOS (Réglages → Réseau → Coupe-feu).

## Étape 3 — Configurer l'adresse d'Ollama et pousser

1. Dans [`openshift/deployment.yaml`](../openshift/deployment.yaml), mettre l'IP relevée à l'étape 2 :

   ```yaml
   - name: OLLAMA_URL
     value: "http://192.168.1.119:11434/api/chat"
   ```

2. Pousser sur `main`, car c'est là que le pipeline ira chercher le code :

   ```bash
   git add openshift/deployment.yaml
   git commit -m "config: IP d'Ollama"
   git push origin main
   ```

Si l'IP est déjà la bonne, il suffit de vérifier que `main` est à jour : `git status` puis `git push`.

## Étape 4 — Se connecter au cluster en administrateur

```bash
eval $(crc oc-env)
crc console --credentials       # affiche la commande de login kubeadmin, mot de passe compris
oc login -u kubeadmin https://api.crc.testing:6443
oc whoami                       # → kubeadmin
```

Il faut être administrateur du cluster pour l'étape 5 (installer un opérateur). Les étapes suivantes marchent aussi avec l'utilisateur `developer`.

## Étape 5 — Installer l'opérateur OpenShift Pipelines

C'est l'opérateur qui ajoute Tekton au cluster. On l'installe une seule fois pour tout le cluster.

```bash
oc apply -f tekton/operator-subscription.yaml
```

L'installation prend 2 à 5 minutes. Pour la suivre :

```bash
oc get csv -n openshift-operators | grep -i pipelines
# relancer jusqu'à ce que la colonne PHASE passe de "Installing" à "Succeeded"
```

L'opérateur installe ensuite des tâches prêtes à l'emploi, dont 3 servent au pipeline. Cela peut prendre une minute de plus :

```bash
oc get tasks -n openshift-pipelines | grep -E '^(git-clone|buildah|openshift-client) '
# → les 3 lignes doivent apparaître
```

Autre option : la console web, Operators → OperatorHub → « Red Hat OpenShift Pipelines » → Install, avec les réglages par défaut.

## Étape 6 — Créer le namespace

```bash
oc new-project ollama-agent-node
# Ne garder que les 5 derniers runs (nettoyage automatique par l'opérateur)
oc annotate namespace ollama-agent-node operator.tekton.dev/prune.keep=5
```

L'opérateur crée automatiquement dans ce namespace le ServiceAccount `pipeline`, qui exécute les tâches. Vérifier qu'il existe et qu'il a les droits pour déployer :

```bash
oc get sa pipeline -n ollama-agent-node
oc auth can-i patch deployments -n ollama-agent-node \
  --as=system:serviceaccount:ollama-agent-node:pipeline    # → yes
```

Si `pipeline` n'existe pas encore, attendre quelques secondes et relancer la commande.

## Étape 7 — Vérifier que le cluster joint Ollama

Un pod temporaire interroge Ollama depuis l'intérieur du cluster, puis est supprimé :

```bash
oc run ollama-check -n ollama-agent-node --rm -i --restart=Never \
  --image=registry.access.redhat.com/ubi9/ubi-minimal -- \
  curl -s -m 5 -o /dev/null -w "%{http_code}\n" http://192.168.1.119:11434/api/tags
# → 200
```

Remplacer `192.168.1.119` par l'IP relevée à l'étape 2, la même que dans `OLLAMA_URL`.

Si ce n'est pas 200, revoir l'étape 2 : Ollama n'est pas exposé sur le réseau, ou l'IP n'est pas la bonne. Inutile d'aller plus loin tant que ça ne marche pas : l'appli se déploierait, mais chaque message renverrait une erreur.

## Étape 8 — Installer le volume de travail et le pipeline

```bash
oc apply -n ollama-agent-node -f tekton/workspace-pvc.yaml -f tekton/pipeline.yaml
oc get pipeline,pvc -n ollama-agent-node
```

La PVC reste en `Pending` jusqu'au premier run. C'est normal : la StorageClass de CRC ne crée le volume qu'au premier pod qui l'utilise.

## Étape 9 — Lancer le premier déploiement

```bash
oc create -f tekton/pipelinerun.yaml -n ollama-agent-node
# → pipelinerun.tekton.dev/ollama-agent-node-xxxxx created
```

Utiliser `create`, pas `apply` : chaque run reçoit ainsi un nom unique.

Autre option : la console web, perspective Developer → Pipelines → `ollama-agent-node` → Actions → Start. Pour le workspace `source`, choisir « PersistentVolumeClaim » puis `pipeline-source`.

Le premier run est plus long (5 à 10 min), car il faut télécharger les images `node:24-slim` et buildah.

## Étape 10 — Suivre le run

```bash
oc get pipelinerun -n ollama-agent-node        # SUCCEEDED passe à True à la fin
oc get taskrun -n ollama-agent-node            # une ligne par tâche
oc get pods -n ollama-agent-node               # un pod par tâche
oc logs -n ollama-agent-node -f <nom-du-pod> --all-containers
```

Avec `tkn`, une seule commande suffit : `tkn pr logs -f --last -n ollama-agent-node`.

La console web affiche aussi les étapes et leurs logs en direct : Pipelines → PipelineRuns.

## Étape 11 — Vérifier l'appli

```bash
oc get pods -n ollama-agent-node -l app=ollama-agent-node       # → 1/1 Running
oc get route ollama-agent-node -n ollama-agent-node -o jsonpath='{.spec.host}{"\n"}'
# → ollama-agent-node-ollama-agent-node.apps-crc.testing

curl -N -X POST http://ollama-agent-node-ollama-agent-node.apps-crc.testing/api/chat \
  -H 'content-type: application/json' -d '{"message":"Bonjour"}'
# → événements "text" puis "done"
```

Pour utiliser le chat, ouvrir <http://ollama-agent-node-ollama-agent-node.apps-crc.testing> dans le navigateur. Les adresses `*.apps-crc.testing` sont résolues sur le Mac par CRC.

Pour vérifier quelle version tourne :

```bash
oc get istag -n ollama-agent-node                   # une image par commit déployé
oc get deploy ollama-agent-node -n ollama-agent-node \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'   # …@sha256:<digest>
```

Pour lire les logs de l'appli (messages reçus, durée des réponses, erreurs vers Ollama) :

```bash
oc logs -f deploy/ollama-agent-node -n ollama-agent-node
```

Ce sont les mêmes logs qu'en local avec `npm start`. C'est la première chose à regarder si le chat affiche une erreur.

---

## Déploiements suivants

Une fois l'installation faite, chaque nouvelle version se déploie en 3 commandes :

```bash
npm test                                             # facultatif : tests en local
git commit -am "..." && git push origin main
oc create -f tekton/pipelinerun.yaml -n ollama-agent-node
```

Deux cas particuliers :

- **Après une modification de `tekton/pipeline.yaml`**, réappliquer le fichier avant de lancer un run : `oc apply -f tekton/pipeline.yaml -n ollama-agent-node`. Le pipeline est lu dans le cluster, pas dans Git.
- **Les fichiers `openshift/*.yaml`**, eux, sont lus dans Git à chaque run : il suffit de pousser.

### Paramètres du pipeline

| Paramètre | Défaut | Quand le changer |
|---|---|---|
| `git-revision` | `main` | Déployer une autre branche, un tag ou un commit précis (rollback) |
| `git-url` | `https://github.com/nicolas-budin/ollama_agent_node.git` | Déployer depuis un fork |
| `image` | `…/ollama-agent-node/ollama-agent-node` dans le registre interne | Rarement : pousser l'image ailleurs |

`oc create -f tekton/pipelinerun.yaml` utilise toujours les valeurs par défaut. Pour en changer une sans modifier de fichier suivi par Git, deux options :

- **Avec `tkn`** :

  ```bash
  tkn pipeline start ollama-agent-node -n ollama-agent-node \
    -p git-revision=<sha-ou-branche> \
    -w name=source,claimName=pipeline-source \
    -s pipeline --showlog
  ```

- **Depuis la console** : Pipelines → `ollama-agent-node` → Actions → Start. Le formulaire propose chaque paramètre.

## Rollback

- **Redéployer un ancien commit** : lancer le pipeline avec `git-revision=<sha>` (voir ci-dessus). Le commit doit contenir le dossier `openshift/`, sinon la tâche `deploy` échoue. Les tests de ce commit sont aussi rejoués.
- **Plus rapide, sans rebuild** : `oc rollout undo deployment/ollama-agent-node -n ollama-agent-node` remet la version précédente en quelques secondes. Attention, le prochain run sur `main` redéploiera `main`.

## Faire le ménage dans les images

Chaque run ajoute une image d'environ 250 Mo dans le registre interne (un tag par commit), et rien ne les supprime tant qu'un tag les référence. Pour lister les tags et supprimer les anciens :

```bash
oc get istag -n ollama-agent-node --sort-by=.metadata.creationTimestamp
oc tag -d ollama-agent-node:<vieux-sha> -n ollama-agent-node
```

Garder au moins l'image en cours d'utilisation et une ou deux précédentes, pour pouvoir revenir en arrière. L'espace disque est libéré par le nettoyage automatique d'OpenShift, qui tourne chaque nuit à minuit (`oc get cronjob image-pruner -n openshift-image-registry`).

## Après un redémarrage (Mac ou CRC)

Le cluster ne redémarre pas tout seul :

```bash
crc start
eval $(crc oc-env)
oc get pods -n ollama-agent-node           # le pod de l'appli redémarre tout seul
```

Ensuite :

- **Vérifier qu'Ollama tourne** et qu'il est toujours exposé sur le réseau (étape 2).
- **Vérifier que l'IP du Mac n'a pas changé** (`ipconfig getifaddr en0`). Si elle a changé, refaire les étapes 3 et 7, puis relancer un run.
- L'historique de conversation est perdu à chaque redémarrage du pod : il est gardé en mémoire.

## En cas d'échec

| Symptôme | Cause probable |
|---|---|
| `fetch-source` en échec | Dépôt ou révision introuvable, ou pas d'accès Internet depuis CRC |
| `test` en échec | Un test échoue : les logs montrent lequel. Le pipeline s'arrête avant le build |
| `build-image` en échec | Erreur dans le Dockerfile, ou image de base impossible à télécharger |
| `deploy` en échec (`rollout status` expire) | Le pod ne démarre pas : `oc describe pod -l app=ollama-agent-node -n ollama-agent-node` |
| Run réussi, mais événement `error` dans le chat | Lire les logs de l'appli (`oc logs deploy/ollama-agent-node -n ollama-agent-node`). Le plus souvent, Ollama est injoignable depuis le pod : refaire l'étape 7 |
| Un run qui marchait casse après une mise à jour de l'opérateur | Les paramètres d'une tâche fournie ont changé : comparer avec `oc get task <nom> -n openshift-pipelines -o yaml` (voir « Choix et pièges ») |
| Run bloqué en attente, PVC en `Pending` | Volume non créé : `oc describe pvc pipeline-source -n ollama-agent-node` |

## Désinstaller / repartir de zéro

```bash
# Supprime l'appli, le pipeline, les runs, la PVC et les images du namespace
oc delete project ollama-agent-node

# Désinstaller l'opérateur (seulement si rien d'autre n'utilise Tekton).
# D'abord la TektonConfig : l'opérateur retire alors proprement ce qu'il a
# déployé (namespace openshift-pipelines, contrôleurs, tâches fournies).
oc delete tektonconfig config
oc delete subscription openshift-pipelines-operator-rh -n openshift-operators
oc delete csv -n openshift-operators -l operators.coreos.com/openshift-pipelines-operator-rh.openshift-operators
```

Les CRD Tekton (`oc get crd | grep tekton`) restent après la désinstallation, comme pour tout opérateur OLM. Elles ne gênent pas et sont réutilisées lors d'une réinstallation.

La StorageClass de CRC est en `Retain` : après `oc delete project`, le PV de l'ancienne PVC reste en `Released`. Pour le supprimer : `oc get pv | grep pipeline-source`, puis `oc delete pv <nom>`.

## Choix et pièges

- **Tag = SHA complet du commit**, déploiement **par digest** : chaque image dit de quel commit elle vient, et le pod lance exactement l'image construite par ce run.
- **PVC fixe plutôt que `volumeClaimTemplate`** : la StorageClass de CRC est en `Retain`, donc chaque run laisserait un PV orphelin. `git-clone` vide le dossier au début de chaque run. Deux runs simultanés se marcheraient dessus, mais les runs sont lancés à la main.
- **`OLLAMA_URL` = IP LAN du Mac**, écrite en dur dans `openshift/deployment.yaml`, car Ollama tourne hors du cluster. Si l'IP change (DHCP), refaire les étapes 2, 3 et 7, puis relancer un run.
- **1 réplique, `strategy: Recreate`** : l'historique de conversation vit en mémoire du pod.
- **Timeout de la Route à 5 min** : les 30 s par défaut couperaient les réponses longues.
- **Droits** : le ServiceAccount `pipeline`, créé par l'opérateur dans chaque namespace, a le rôle `edit`. C'est suffisant pour pousser dans l'ImageStream et appliquer les manifestes.
- **Mises à jour automatiques de l'opérateur** : l'abonnement suit le canal `latest` avec `installPlanApproval: Automatic`, donc l'opérateur se met à jour tout seul. Le pipeline utilise les tâches fournies sans numéro de version (`git-clone`, `buildah`, `openshift-client`) : une nouvelle version pourrait en changer les paramètres ou les résultats.
  - Pour figer : passer `installPlanApproval: Manual` dans `operator-subscription.yaml`, ou référencer les tâches versionnées (ex. `git-clone-1-24-0`, visibles avec `oc get tasks -n openshift-pipelines`).
- **`.dockerignore` exclut `node_modules`** : la tâche `test` les laisse dans le dossier de travail, qui sert aussi de contexte au build de l'image.
