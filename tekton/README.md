# Pipeline Tekton de CD (OpenShift Pipelines sur CRC)

Ce guide explique comment installer et configurer, **depuis zéro**, le pipeline qui déploie l'appli sur le cluster OpenShift local (CRC) du Mac. Chaque commande est expliquée : ce qu'elle fait, le sens de ses options, le résultat attendu et quoi faire si ça ne marche pas.

## Sommaire

- [Notions à connaître](#notions-à-connaître)
- [Vue d'ensemble](#vue-densemble)
- [Les fichiers](#les-fichiers)
- Installation :
  - [1. Prérequis sur le Mac](#étape-1--prérequis-sur-le-mac)
  - [2. Rendre Ollama joignable](#étape-2--rendre-ollama-joignable-depuis-le-cluster)
  - [3. Configurer l'adresse d'Ollama](#étape-3--configurer-ladresse-dollama-et-pousser)
  - [4. Connexion au cluster](#étape-4--se-connecter-au-cluster-en-administrateur)
  - [5. Opérateur Pipelines](#étape-5--installer-lopérateur-openshift-pipelines)
  - [6. Namespace](#étape-6--créer-le-namespace-de-lappli)
  - [7. Test réseau](#étape-7--vérifier-que-le-cluster-joint-ollama)
  - [8. Pipeline](#étape-8--installer-le-volume-de-travail-et-le-pipeline)
  - [9. Premier run](#étape-9--lancer-le-premier-déploiement)
  - [10. Suivi](#étape-10--suivre-le-run)
  - [11. Vérification](#étape-11--vérifier-lappli)
- [Comprendre les fichiers YAML](#comprendre-les-fichiers-yaml)
- [Et ensuite](#et-ensuite)

Une fois l'installation faite, l'usage au quotidien (déployer une nouvelle version, revenir en arrière, dépanner, désinstaller) est décrit dans **[EXPLOITATION.md](EXPLOITATION.md)**.

---

## Notions à connaître

Les termes utilisés dans la suite, du plus général au plus spécifique :

| Terme | En une phrase |
|---|---|
| **CRC** (*OpenShift Local*) | Un cluster OpenShift complet dans une machine virtuelle sur le Mac. |
| **`oc`** | La ligne de commande d'OpenShift. Elle envoie des ordres à l'API du cluster ; c'est un `kubectl` avec des commandes en plus. |
| **Ressource / manifeste** | Tout ce qui existe dans le cluster est un objet décrit en YAML (un *manifeste*). `oc apply -f fichier.yaml` envoie ce fichier ; le cluster fait ensuite en sorte que la réalité corresponde à la description. |
| **Namespace / projet** | Un espace isolé dans le cluster, qui a ses propres ressources et ses propres droits. Sur OpenShift, un *projet* est un namespace avec quelques réglages en plus. Ici, tout ce qui concerne l'appli vit dans `ollama-agent-node`. |
| **Opérateur** | Un programme qui tourne dans le cluster et installe ou gère un logiciel à ta place. Ici, l'opérateur *OpenShift Pipelines* installe Tekton. |
| **OLM, Subscription, CSV** | OLM (*Operator Lifecycle Manager*) est le gestionnaire d'opérateurs d'OpenShift. Une **Subscription** lui demande d'installer un opérateur et de le tenir à jour. Le **CSV** (*ClusterServiceVersion*) représente la version installée et son état. |
| **Tekton** | Le moteur de CI/CD intégré à Kubernetes. Chaque étape d'un pipeline tourne dans un conteneur, à l'intérieur du cluster. |
| **Task / step** | Une *Task* est une tâche, par exemple « cloner un dépôt ». Elle est faite de *steps*, chacun étant un conteneur. Une Task tourne dans un pod. |
| **Pipeline** | Un enchaînement de Tasks, avec des paramètres. C'est une **définition** : la créer ne lance rien. |
| **PipelineRun / TaskRun** | Une **exécution** du pipeline (un *run*), et l'exécution de chacune de ses tâches. On crée un PipelineRun à chaque déploiement. |
| **Workspace** | Un dossier partagé entre les tâches d'un run. C'est là que `git-clone` dépose le code que les tâches suivantes utilisent. |
| **Resolver `cluster`** | La façon dont le pipeline va chercher une Task rangée dans un autre namespace. Ici, ce sont les tâches fournies par l'opérateur, dans `openshift-pipelines`. |
| **PVC / StorageClass / PV** | Une PVC (*PersistentVolumeClaim*) est une demande de disque. La StorageClass décide comment le disque est créé, et le PV est le disque obtenu. Le workspace du pipeline est une PVC. |
| **ServiceAccount / rôle** | L'identité avec laquelle un pod parle au cluster, et les droits qui y sont attachés. Les tâches du pipeline tournent avec le ServiceAccount `pipeline`. |
| **Registre interne / ImageStream** | OpenShift a son propre registre d'images. Une ImageStream regroupe les versions (*tags*) d'une image, un peu comme un dépôt Docker Hub. |
| **Deployment / Pod** | Un *pod* est un ou plusieurs conteneurs qui tournent ensemble. Le *Deployment* décrit quel pod doit tourner (image, variables, nombre de copies), et OpenShift le maintient en vie. |
| **Service / Route** | Le *Service* donne une adresse interne stable vers le pod. La *Route* expose ce Service à l'extérieur du cluster, avec une URL. |

---

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

## Les fichiers

| Fichier | Rôle | Qui l'applique | Namespace |
|---|---|---|---|
| `tekton/operator-subscription.yaml` | Installe l'opérateur OpenShift Pipelines | toi, une fois (étape 5) | `openshift-operators`, écrit dans le fichier |
| `tekton/workspace-pvc.yaml` | Volume `pipeline-source`, dossier de travail partagé par les tâches, réutilisé à chaque run | toi, une fois (étape 8) | `ollama-agent-node`, via `-n` |
| `tekton/pipeline.yaml` | Le pipeline (4 tâches) | toi (étape 8, puis à chaque modification) | `ollama-agent-node`, via `-n` |
| `tekton/pipelinerun.yaml` | Modèle pour lancer un run | toi, à chaque déploiement (étape 9) | `ollama-agent-node`, via `-n` |
| `openshift/deployment.yaml` | Deployment de l'appli (image remplacée par le pipeline) | le pipeline, à chaque run | celui du run |
| `openshift/service.yaml`, `openshift/route.yaml` | Exposition de l'appli | le pipeline, à chaque run | celui du run |

**D'où vient le namespace :**

- `operator-subscription.yaml` indique lui-même son namespace, `openshift-operators`. Il est imposé par OLM et existe dès la création du cluster.
- Les autres fichiers ne contiennent pas de `namespace:`.
  - Pour les fichiers `tekton/`, c'est le `-n ollama-agent-node` de la commande qui décide.
  - Pour les fichiers `openshift/`, c'est la tâche `deploy` qui les applique, avec un `oc` sans `-n`. Or un `oc` lancé dans un pod travaille dans le namespace de ce pod. L'appli se retrouve donc dans le même namespace que le pipeline, et le pipeline ne peut déployer nulle part ailleurs : son ServiceAccount n'a de droits que là.

Le contenu de chaque fichier est expliqué dans [Comprendre les fichiers YAML](#comprendre-les-fichiers-yaml).

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

### 1.1 Installer et démarrer CRC

Télécharger CRC et le *pull secret* sur <https://console.redhat.com/openshift/create/local>. Il faut un compte Red Hat, gratuit. Le pull secret est un fichier d'identifiants qui autorise le cluster à télécharger les images de Red Hat. Installer ensuite le `.pkg`.

```bash
crc config set memory 16384
```

Règle la mémoire de la VM à **16384 Mio (16 Go)**. Par défaut, CRC en prend environ 11, ce qui ne suffit pas pour OpenShift, Tekton et un build d'image en même temps. Le réglage est enregistré dans `~/.crc/config.yaml` et s'applique au prochain `crc start`.

```bash
crc config set disk-size 100
```

Règle le disque de la VM à **100 Gio**. Les images téléchargées par les builds (Node, buildah) et celles produites par le pipeline s'accumulent dans la VM.

```bash
crc setup
```

Prépare le Mac, **une seule fois** :

- vérifie la configuration ;
- télécharge le *bundle*, l'image disque d'OpenShift, soit plusieurs Go ;
- installe le démon réseau de CRC ;
- configure le DNS pour que les adresses `*.crc.testing` et `*.apps-crc.testing` pointent vers la VM.

La commande peut demander le mot de passe administrateur du Mac.

```bash
crc start
```

Crée et démarre la VM, puis OpenShift à l'intérieur. Au premier lancement, la commande demande le pull secret : colle le contenu du fichier téléchargé. Compter environ 10 minutes la première fois, et quelques minutes ensuite. À la fin, elle affiche l'adresse de la console et les identifiants.

```bash
crc status
```

Affiche l'état de la VM et d'OpenShift, ainsi que la mémoire et le disque utilisés. **Attendu : `OpenShift: Running`.**

### 1.2 Mettre `oc` dans le PATH

```bash
eval $(crc oc-env)
oc version
```

- `crc oc-env` **affiche** une ligne du type `export PATH="/Users/<toi>/.crc/bin/oc:$PATH"`.
- `eval $(...)` **exécute** cette ligne dans le terminal courant. La commande `oc` fournie par CRC, dans la bonne version, devient alors disponible.
- `oc version` le confirme : elle affiche la version du client, et celle du serveur si tu es connecté.

L'effet ne dure que pour **ce terminal**. Pour ne pas le refaire à chaque fois, ajouter la ligne `eval $(crc oc-env)` dans `~/.zshrc`.

La console web s'ouvre avec `crc console`, à l'adresse <https://console-openshift-console.apps-crc.testing>.

### 1.3 Installer Ollama et le modèle

```bash
brew install --cask ollama
```

Installe l'application Ollama avec Homebrew. On peut aussi la télécharger sur <https://ollama.com>. Au lancement, l'app démarre le serveur Ollama sur le port 11434.

```bash
ollama pull gemma4:26b
```

Télécharge le modèle, soit environ 17 Go.

```bash
ollama list
```

Liste les modèles installés. **Attendu : une ligne `gemma4:26b`.**

### 1.4 Récupérer le dépôt

```bash
git clone https://github.com/nicolas-budin/ollama_agent_node.git
cd ollama_agent_node
```

Copie le dépôt sur le Mac et se place dedans. **Toutes les commandes suivantes se lancent depuis la racine du dépôt**, car elles utilisent des chemins relatifs comme `tekton/pipeline.yaml`.

### 1.5 Facultatif : la CLI Tekton

```bash
brew install tektoncd-cli
```

Installe `tkn`, la ligne de commande de Tekton. Elle n'est pas indispensable, mais elle simplifie le suivi des runs (étape 10) et le lancement avec des paramètres ([Paramètres du pipeline](EXPLOITATION.md#paramètres-du-pipeline)).

---

## Étape 2 — Rendre Ollama joignable depuis le cluster

L'appli tourne dans un pod, à l'intérieur de la VM CRC, et doit appeler Ollama qui tourne sur le Mac. Or, par défaut, Ollama n'écoute que sur `localhost` : il n'accepte que les connexions venant du Mac lui-même. Il faut l'ouvrir au réseau local, puis le joindre par l'IP du Mac.

### 2.1 Exposer Ollama sur le réseau

Deux façons de faire, au choix :

- **Dans l'app Ollama** : Settings → activer **« Expose Ollama to the network »**. Le réglage est conservé après un redémarrage.
- **En ligne de commande** :

  ```bash
  launchctl setenv OLLAMA_HOST 0.0.0.0
  ```

  `launchctl setenv` définit une variable d'environnement pour les applications lancées par macOS. `OLLAMA_HOST=0.0.0.0` demande à Ollama d'écouter sur **toutes** les interfaces réseau, et plus seulement sur `localhost`. Il faut ensuite **quitter et relancer l'app Ollama** pour qu'elle lise la variable. Attention : ce réglage est **perdu au redémarrage du Mac**.

> **Sécurité.** Ollama n'a pas d'authentification. Une fois exposé, **n'importe quel appareil du même réseau** peut utiliser le modèle et lister ou supprimer les modèles installés. À ne faire que sur un réseau de confiance (maison), pas sur un Wi-Fi public ou d'entreprise.
>
> En dehors de ce cas, désactiver l'exposition (Settings, ou `launchctl unsetenv OLLAMA_HOST` puis relancer l'app), ou activer le pare-feu macOS (Réglages → Réseau → Coupe-feu).

### 2.2 Relever l'IP du Mac

```bash
ipconfig getifaddr en0 || ipconfig getifaddr en1
```

`ipconfig getifaddr <interface>` affiche l'adresse IPv4 d'une interface réseau. `en0` est en général le Wi-Fi, `en1` une autre interface selon le modèle de Mac. `||` lance la deuxième commande seulement si la première n'a rien trouvé. **Attendu : une adresse comme `192.168.1.119`.** Dans la suite, remplacer `192.168.1.119` par ton adresse.

### 2.3 Vérifier qu'Ollama répond sur cette IP

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://192.168.1.119:11434/api/tags
```

Appelle l'API d'Ollama qui liste les modèles (`/api/tags`), **par l'IP réseau** et non par `localhost`.

| Option | Sens |
|---|---|
| `-s` | silencieux : pas de barre de progression |
| `-o /dev/null` | jette le contenu de la réponse |
| `-w "%{http_code}\n"` | n'affiche que le code HTTP |

**Attendu : `200`.**

- `000` : Ollama n'écoute pas sur le réseau. Revoir le point 2.1, et vérifier que l'app a bien été relancée.
- Pas de réponse : l'IP est fausse.

---

## Étape 3 — Configurer l'adresse d'Ollama et pousser

L'appli trouve Ollama grâce à la variable d'environnement `OLLAMA_URL`, définie dans [`openshift/deployment.yaml`](../openshift/deployment.yaml). Mettre ton IP dans ce fichier :

```yaml
- name: OLLAMA_URL
  value: "http://192.168.1.119:11434/api/chat"
```

Puis envoyer la modification sur GitHub, car c'est là que le pipeline lira ce fichier :

```bash
git add openshift/deployment.yaml
git commit -m "config: IP d'Ollama"
git push origin main
```

- `git add` ajoute le fichier modifié au prochain commit.
- `git commit -m` crée le commit avec ce message.
- `git push origin main` envoie les commits locaux vers la branche `main` sur GitHub (`origin`).

Si l'IP était déjà la bonne, il n'y a rien à modifier. Vérifier seulement avec `git status` que tout est bien poussé : le message `Your branch is up to date with 'origin/main'` le confirme.

---

## Étape 4 — Se connecter au cluster en administrateur

```bash
crc console --credentials
```

Affiche les deux comptes créés par CRC, avec pour chacun la commande `oc login` complète, mot de passe compris :

- **`developer`** : utilisateur normal ;
- **`kubeadmin`** : administrateur du cluster.

Il faut `kubeadmin` pour l'étape 5, car installer un opérateur touche tout le cluster.

```bash
oc login -u kubeadmin -p <mot-de-passe> https://api.crc.testing:6443
```

Se connecte à l'API du cluster, à l'adresse `https://api.crc.testing:6443`.

- `-u` : l'utilisateur ;
- `-p` : le mot de passe, affiché par la commande précédente. Sans `-p`, `oc` le demande.

`oc` enregistre un jeton de connexion dans `~/.kube/config` : les commandes suivantes l'utilisent automatiquement. Si `oc` demande s'il faut accepter un certificat non vérifié, répondre `y`, car le cluster local utilise un certificat auto-signé.

```bash
oc whoami
```

Affiche l'utilisateur connecté. **Attendu : `kubeadmin`.**

---

## Étape 5 — Installer l'opérateur OpenShift Pipelines

Tekton n'est pas installé par défaut sur OpenShift. On l'ajoute avec l'opérateur **Red Hat OpenShift Pipelines**, une seule fois pour tout le cluster. L'installation se fait en trois temps : a) l'opérateur, b) Tekton, installé par l'opérateur, c) le menu de la console.

### 5a. S'abonner à l'opérateur

```bash
oc apply -f tekton/operator-subscription.yaml
```

- `oc apply -f <fichier>` envoie le manifeste au cluster : il crée l'objet s'il n'existe pas, ou le met à jour s'il existe. La commande peut donc être relancée sans risque.
- Ici, l'objet est une **Subscription** : elle demande à OLM d'installer l'opérateur `openshift-pipelines-operator-rh` depuis le catalogue Red Hat, et de le tenir à jour. Son contenu est détaillé plus bas : [`operator-subscription.yaml`](#operator-subscriptionyaml).
- Pas de `-n` : le fichier indique lui-même son namespace, `openshift-operators`. Le namespace de l'appli n'est pas encore nécessaire, il sera créé à l'étape 6.

**Attendu : `subscription.operators.coreos.com/openshift-pipelines-operator-rh created`.** La commande répond tout de suite, car elle ne fait que déposer la demande : OLM travaille ensuite en arrière-plan.

```bash
oc get csv -n openshift-operators | grep -i pipelines
```

- `oc get csv` liste les ClusterServiceVersions, c'est-à-dire les opérateurs installés et leur état.
- `-n openshift-operators` regarde dans ce namespace.
- `grep -i pipelines` ne garde que la ligne de l'opérateur Pipelines, sans tenir compte des majuscules.

**Attendu : la colonne `PHASE` passe de `Installing` à `Succeeded`**, en 1 à 3 minutes. Relancer la commande jusque-là.

### 5b. Attendre que l'opérateur installe Tekton

`Succeeded` veut dire que **l'opérateur** tourne, pas encore que **Tekton** est prêt. L'opérateur crée ensuite le namespace `openshift-pipelines`, les contrôleurs Tekton, les nouveaux types de ressources (`Task`, `Pipeline`…) et les tâches fournies. Il faut compter 2 à 3 minutes de plus.

Tant que ce n'est pas fini, `oc get tasks` répond `error: the server doesn't have a resource type "tasks"`. C'est normal : le type `Task` n'existe pas encore.

```bash
oc get tektonconfig
```

`TektonConfig` est l'objet (nommé `config`) par lequel l'opérateur décrit ce qu'il installe. **Attendu : `READY` = `True`, et la colonne `VERSION` remplie** (ex. `1.24.0`). Tant que `READY` est vide ou `False`, l'installation continue.

```bash
oc get tasks -n openshift-pipelines | grep -E '^(git-clone|buildah|openshift-client) '
```

- `oc get tasks -n openshift-pipelines` liste les tâches fournies par l'opérateur.
- `grep -E '^(git-clone|buildah|openshift-client) '` ne garde que les trois utilisées par notre pipeline. `^` signifie « début de ligne », et l'espace final exclut les variantes versionnées comme `git-clone-1-24-0`.

**Attendu : 3 lignes.**

### 5c. Activer le menu Pipelines dans la console web

L'opérateur fournit un **plugin** pour la console web, qui ajoute le menu *Pipelines*. Quand on installe l'opérateur en ligne de commande, ce plugin est créé mais **pas activé**.

```bash
oc get consoleplugin pipelines-console-plugin
```

Vérifie que le plugin existe. Il est créé pendant l'étape 5b. **Attendu : une ligne `pipelines-console-plugin`.**

```bash
oc patch consoles.operator.openshift.io cluster --type=json \
  -p '[{"op":"add","path":"/spec/plugins/-","value":"pipelines-console-plugin"}]'
```

- `oc patch` modifie une partie d'un objet existant, sans le réécrire en entier.
- L'objet modifié est `consoles.operator.openshift.io/cluster`, la configuration de la console web.
- `--type=json` indique un *JSON Patch* : une liste d'opérations.
- L'opération `add` sur `/spec/plugins/-` ajoute `pipelines-console-plugin` **à la fin** de la liste des plugins activés (`-` = après le dernier élément).

**Attendu : `console.operator.openshift.io/cluster patched`.**

```bash
oc get consoles.operator.openshift.io cluster -o jsonpath='{.spec.plugins}{"\n"}'
```

Affiche la liste des plugins activés. `-o jsonpath=...` extrait un seul champ de l'objet. **Attendu : la liste contient `"pipelines-console-plugin"`.** Ne lancer le `oc patch` qu'une fois, sinon le plugin apparaît deux fois dans la liste.

Recharger ensuite la console. Si un bandeau « Web console update is available » s'affiche, cliquer sur *Refresh*. **Le menu de gauche doit maintenant contenir *Pipelines*.**

> Autre option pour toute l'étape 5 : la console web, Operators → OperatorHub → « Red Hat OpenShift Pipelines » → Install, avec les réglages par défaut. L'écran d'installation propose alors d'activer le plugin console : laisser « Enable » coché.

---

## Étape 6 — Créer le namespace de l'appli

```bash
oc new-project ollama-agent-node
```

Crée le projet (namespace) `ollama-agent-node`, qui contiendra le pipeline, ses runs, son volume, les images et l'appli. Tu en deviens administrateur.

La commande fait aussi de ce projet le **projet courant** : les commandes `oc` sans `-n` s'y appliqueront. La doc met quand même `-n ollama-agent-node` partout, pour que chaque commande marche quel que soit le projet courant.

**Attendu : `Now using project "ollama-agent-node" on server "https://api.crc.testing:6443"`.**

```bash
oc annotate namespace ollama-agent-node operator.tekton.dev/prune.keep=5
```

Ajoute une *annotation* au namespace, c'est-à-dire une étiquette clé/valeur lue par les outils. L'opérateur Pipelines lit celle-ci pour **ne garder que les 5 derniers runs** et supprimer les plus anciens, avec leurs pods et leurs logs. Sans elle, les runs s'accumulent. **Attendu : `namespace/ollama-agent-node annotated`.**

```bash
oc get sa pipeline -n ollama-agent-node
```

Dès qu'un namespace est créé, l'opérateur y ajoute le **ServiceAccount `pipeline`**, l'identité avec laquelle tournent les tâches du pipeline. `sa` est l'abréviation de `serviceaccount`. **Attendu : une ligne `pipeline`.** Sinon, attendre quelques secondes et relancer.

```bash
oc auth can-i patch deployments -n ollama-agent-node \
  --as=system:serviceaccount:ollama-agent-node:pipeline
```

- `oc auth can-i <verbe> <ressource>` demande au cluster si une action est autorisée.
- `--as=...` pose la question **à la place** du ServiceAccount `pipeline`. Le format est `system:serviceaccount:<namespace>:<nom>`.

On vérifie ainsi qu'il pourra mettre à jour le Deployment de l'appli : l'opérateur lui donne le rôle `edit` sur le namespace. **Attendu : `yes`.**

---

## Étape 7 — Vérifier que le cluster joint Ollama

L'étape 2 a vérifié qu'Ollama répond **depuis le Mac**. Il faut aussi vérifier qu'il répond **depuis un pod du cluster**, là où tournera l'appli. Sans ça, l'appli se déploierait, mais chaque message renverrait une erreur.

```bash
oc run ollama-check -n ollama-agent-node --rm -i --restart=Never \
  --image=registry.access.redhat.com/ubi9/ubi-minimal -- \
  curl -s -m 5 -o /dev/null -w "%{http_code}\n" http://192.168.1.119:11434/api/tags
```

| Partie | Sens |
|---|---|
| `oc run ollama-check` | crée un pod nommé `ollama-check` |
| `--image=registry.access.redhat.com/ubi9/ubi-minimal` | image Red Hat minimale qui contient `curl` |
| `--restart=Never` | un pod simple qui s'arrête à la fin de la commande, sans Deployment qui le relancerait |
| `-i` | affiche la sortie du pod dans le terminal |
| `--rm` | supprime le pod une fois terminé |
| `--` | tout ce qui suit est la commande à lancer dans le pod |
| `curl ... -m 5` | le même test qu'à l'étape 2.3, abandonné au bout de 5 secondes |

Remplacer `192.168.1.119` par ton IP, la même que dans `OLLAMA_URL`.

**Attendu : `200`, puis `pod "ollama-check" deleted`.** Si ce n'est pas `200`, revoir l'étape 2 : Ollama n'est pas exposé sur le réseau, ou l'IP n'est pas la bonne. Inutile d'aller plus loin tant que ça ne marche pas.

---

## Étape 8 — Installer le volume de travail et le pipeline

```bash
oc apply -n ollama-agent-node -f tekton/workspace-pvc.yaml -f tekton/pipeline.yaml
```

Envoie deux manifestes dans le namespace (on peut enchaîner plusieurs `-f`) :

- **`workspace-pvc.yaml`** crée la PVC `pipeline-source`, le disque qui servira de dossier de travail partagé entre les tâches d'un run.
- **`pipeline.yaml`** crée le Pipeline `ollama-agent-node` : la **définition** des 4 tâches. Rien ne s'exécute encore.

Les deux fichiers sont expliqués dans [Comprendre les fichiers YAML](#comprendre-les-fichiers-yaml).

**Attendu :**

```text
persistentvolumeclaim/pipeline-source created
pipeline.tekton.dev/ollama-agent-node created
```

```bash
oc get pipeline,pvc -n ollama-agent-node
```

Liste le pipeline et la PVC. On peut demander plusieurs types d'un coup en les séparant par une virgule.

- **Attendu :** le pipeline `ollama-agent-node`, et la PVC `pipeline-source` en **`Pending`**.
- `Pending` est normal : la StorageClass de CRC ne crée le disque qu'au premier pod qui l'utilise, donc au premier run. La PVC passera en `Bound` à ce moment-là.

Après toute modification de `pipeline.yaml`, relancer cette même commande `oc apply` : le cluster utilise sa propre copie du pipeline, pas celle de Git.

Dans la console : **Pipelines → Pipelines**, projet `ollama-agent-node` dans la liste « Project » en haut. Le pipeline apparaît, et un clic dessus montre le graphe des 4 tâches.

---

## Étape 9 — Lancer le premier déploiement

```bash
oc create -f tekton/pipelinerun.yaml -n ollama-agent-node
```

Crée un **PipelineRun**, c'est-à-dire une exécution du pipeline. Tekton lance alors les tâches une par une, chacune dans son propre pod. Le fichier est expliqué dans [`pipelinerun.yaml`](#pipelinerunyaml).

**Pourquoi `create` et pas `apply`** : le fichier ne donne pas de nom fixe au run, mais un préfixe (`generateName: ollama-agent-node-`). Le cluster y ajoute un suffixe aléatoire, pour que chaque run ait un nom unique et que l'historique soit conservé. `oc apply` refuse ce cas (`cannot use generate name with apply`), car il a besoin d'un nom fixe pour savoir quel objet mettre à jour.

**Attendu : `pipelinerun.tekton.dev/ollama-agent-node-xxxxx created`.** Note le nom, il sert à l'étape 10.

Le premier run est plus long (5 à 10 minutes), car le cluster doit télécharger les images `node:24-slim` et buildah.

**Depuis la console web**, au lieu de la commande :

1. Menu **Pipelines → Pipelines**, projet `ollama-agent-node`.
2. Menu ⋮ de la ligne `ollama-agent-node` (ou *Actions* sur sa page) → **Start**.
3. Pour le workspace `source`, **changer** « Empty Directory » (proposé par défaut) en « PersistentVolumeClaim », puis choisir `pipeline-source`.
4. Cliquer sur *Start*.

> **Piège : ne pas garder « Empty Directory ».** Avec ce choix, chaque tâche reçoit son propre dossier vide. `fetch-source` clone le code, mais la tâche `test` ne le voit pas et échoue :
>
> - avec `ERREUR : le workspace 'source' est vide` ;
> - ou, avec une ancienne version du pipeline, avec ``npm ci can only install with an existing package-lock.json``.
>
> `oc create -f tekton/pipelinerun.yaml` n'a pas ce problème : le fichier indique déjà la PVC.

---

## Étape 10 — Suivre le run

```bash
oc get pipelinerun -n ollama-agent-node
```

Liste les runs. La colonne `SUCCEEDED` vaut `Unknown` pendant l'exécution, puis `True` (réussi) ou `False` (échoué). La colonne `REASON` donne le détail : `Running`, `Succeeded`, `Failed`…

```bash
oc get taskrun -n ollama-agent-node
```

Liste les exécutions de tâches : une ligne par tâche du run (`…-fetch-source`, `…-test`, `…-build-image`, `…-deploy`), chacune avec son état. C'est le moyen le plus rapide de voir **quelle tâche** a échoué.

```bash
oc get pods -n ollama-agent-node
```

Chaque tâche tourne dans un pod nommé `<run>-<tâche>-pod`. `Completed` veut dire que la tâche est finie ; `Error` qu'elle a échoué.

```bash
oc logs -f <nom-du-pod> -n ollama-agent-node --all-containers
```

Affiche les logs d'une tâche.

- `-f` suit les logs en direct, comme `tail -f`.
- `--all-containers` est nécessaire parce que chaque *step* d'une tâche est un conteneur distinct du pod. Sans cette option, `oc` demanderait lequel afficher.

**Avec `tkn`**, une seule commande suffit :

```bash
tkn pr logs -f --last -n ollama-agent-node
```

`pr` signifie PipelineRun, et `--last` désigne le dernier run. La commande affiche les logs de toutes les tâches à la suite, au fur et à mesure.

**Dans la console web** : Pipelines → Pipelines → `ollama-agent-node` → onglet *PipelineRuns* → clic sur le run. Chaque tâche est colorée selon son état, et l'onglet *Logs* affiche les logs de chaque tâche.

---

## Étape 11 — Vérifier l'appli

```bash
oc get pods -n ollama-agent-node -l app=ollama-agent-node
```

`-l app=ollama-agent-node` filtre sur une étiquette (*label*) : on ne voit que le pod de l'appli, pas ceux des tâches. **Attendu : `1/1` et `Running`**, c'est-à-dire 1 conteneur prêt sur 1.

```bash
oc get route ollama-agent-node -n ollama-agent-node -o jsonpath='{.spec.host}{"\n"}'
```

Affiche l'adresse publique de l'appli, extraite de la Route. **Attendu : `ollama-agent-node-ollama-agent-node.apps-crc.testing`**, soit `<route>-<namespace>.apps-crc.testing`. Le DNS configuré par `crc setup` fait pointer ces adresses vers la VM.

```bash
curl -N -X POST http://ollama-agent-node-ollama-agent-node.apps-crc.testing/api/chat \
  -H 'content-type: application/json' -d '{"message":"Bonjour"}'
```

Envoie un message à l'appli, comme le fait le navigateur.

| Option | Sens |
|---|---|
| `-X POST` | requête POST |
| `-H` | indique que le corps est du JSON |
| `-d` | le corps de la requête |
| `-N` | affiche la réponse au fil de l'eau, sans mise en mémoire tampon |

**Attendu : des lignes `event: text` / `data: …` (la réponse, morceau par morceau), puis `event: done`.** Un `event: error` veut dire que l'appli tourne mais ne joint pas Ollama : revoir l'étape 7.

Ouvrir ensuite <http://ollama-agent-node-ollama-agent-node.apps-crc.testing> dans le navigateur pour utiliser le chat.

**Voir quelle version tourne :**

```bash
oc get istag -n ollama-agent-node
```

Liste les images construites (`istag` = ImageStreamTag), une par commit déployé, sous la forme `ollama-agent-node:<sha-du-commit>`.

```bash
oc get deploy ollama-agent-node -n ollama-agent-node \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

Affiche l'image exacte utilisée par le Deployment, sous la forme `…/ollama-agent-node@sha256:<digest>`. Le digest est l'empreinte unique de l'image construite par le dernier run.

**Lire les logs de l'appli :**

```bash
oc logs -f deploy/ollama-agent-node -n ollama-agent-node
```

`deploy/<nom>` désigne le pod actuel du Deployment, sans avoir à chercher son nom exact. Les logs montrent les messages reçus, la durée des réponses et les erreurs vers Ollama : ce sont les mêmes qu'en local avec `npm start`. C'est la première chose à regarder si le chat affiche une erreur.

---

## Comprendre les fichiers YAML

### `operator-subscription.yaml`

```yaml
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription                          # une demande d'installation à OLM
metadata:
  name: openshift-pipelines-operator-rh
  namespace: openshift-operators            # namespace imposé par OLM pour les opérateurs globaux
spec:
  channel: latest                           # suivre la dernière version publiée
  name: openshift-pipelines-operator-rh     # nom de l'opérateur dans le catalogue
  source: redhat-operators                  # catalogue d'où il vient (celui de Red Hat)
  sourceNamespace: openshift-marketplace    # namespace où vit ce catalogue
  installPlanApproval: Automatic            # installer et mettre à jour sans validation manuelle
```

Avec `installPlanApproval: Automatic`, l'opérateur se met à jour tout seul. Voir [Choix et pièges](EXPLOITATION.md#choix-et-pièges) pour le figer.

### `workspace-pvc.yaml`

```yaml
apiVersion: v1
kind: PersistentVolumeClaim     # une demande de disque
metadata:
  name: pipeline-source         # nom référencé par pipelinerun.yaml
spec:
  accessModes:
    - ReadWriteOnce             # monté en écriture par un seul nœud à la fois (CRC n'en a qu'un)
  resources:
    requests:
      storage: 2Gi              # taille demandée : code + node_modules
```

Pas de `storageClassName` : c'est la StorageClass par défaut de CRC (`crc-csi-hostpath-provisioner`) qui est utilisée. Elle crée un dossier sur le disque de la VM. La taille est donc indicative : `oc get pvc` affiche la capacité de tout le disque de la VM, et pas 2 Gio.

### `pipeline.yaml`

Le pipeline déclare des **paramètres**, un **workspace** et **4 tâches**.

```yaml
spec:
  params:                      # valeurs réglables à chaque run
    - name: git-url            # dépôt à cloner
    - name: git-revision       # branche, tag ou SHA (défaut : main)
    - name: image              # où pousser l'image (défaut : registre interne, namespace ollama-agent-node)
  workspaces:
    - name: source             # dossier partagé ; le PipelineRun dit quel disque utiliser
```

Chaque tâche utilise ces valeurs avec la syntaxe `$(params.<nom>)`. Elle peut aussi lire un résultat d'une tâche précédente, avec `$(tasks.<tâche>.results.<résultat>)`.

**1. `fetch-source`** : clone le dépôt.

```yaml
    - name: fetch-source
      taskRef:
        resolver: cluster                 # aller chercher une Task existante dans le cluster…
        params:
          - { name: kind, value: task }
          - { name: name, value: git-clone }                 # … nommée git-clone
          - { name: namespace, value: openshift-pipelines }  # … fournie par l'opérateur
      params:
        - { name: URL, value: $(params.git-url) }
        - { name: REVISION, value: $(params.git-revision) }
      workspaces:
        - { name: output, workspace: source }  # la Task appelle son dossier "output" ; on y branche "source"
```

Produit le résultat **`COMMIT`**, le SHA exact cloné. Il sert à nommer l'image.

**2. `test`** : lance les tests. C'est la seule tâche écrite ici plutôt que fournie par l'opérateur (`taskSpec` = définition directe de la tâche).

```yaml
    - name: test
      runAfter: [fetch-source]            # ne démarre qu'après fetch-source
      taskSpec:
        steps:
          - name: npm-test
            image: docker.io/library/node:24-slim   # conteneur Node 24
            workingDir: $(workspaces.source.path)   # se placer dans le code cloné
            env:                                    # le pod tourne avec un utilisateur sans home :
              - { name: HOME, value: /tmp/home }     # on redirige home et cache npm
              - { name: npm_config_cache, value: /tmp/npm-cache }
            script: |
              # vérifie que le workspace n'est pas vide, puis :
              npm ci && npm run typecheck && npm test                   # backend
              npm --prefix frontend ci && npm --prefix frontend test    # frontend
```

`npm ci` installe exactement les versions de `package-lock.json`. Si une commande échoue, la tâche échoue, et le pipeline s'arrête **avant** le build.

**3. `build-image`** : construit l'image avec **buildah**, un outil qui construit des images à partir du `Dockerfile`, sans démon Docker, et qui peut donc tourner dans un pod.

```yaml
    - name: build-image
      runAfter: [test]
      taskRef: { resolver: cluster, … name: buildah … }
      params:
        - { name: IMAGE, value: "$(params.image):$(tasks.fetch-source.results.COMMIT)" }
```

L'image est poussée dans le registre interne avec le tag `<sha-du-commit>`. Produit le résultat **`IMAGE_DIGEST`** (`sha256:…`).

**4. `deploy`** : déploie avec la tâche `openshift-client`, qui exécute un script `oc`.

```yaml
    - name: deploy
      runAfter: [build-image]
      taskRef: { resolver: cluster, … name: openshift-client … }
      params:
        - name: SCRIPT
          value: |
            oc apply -f openshift/service.yaml -f openshift/route.yaml
            sed "s|IMAGE_PLACEHOLDER|$(params.image)@$(tasks.build-image.results.IMAGE_DIGEST)|" \
              openshift/deployment.yaml | oc apply -f -
            oc rollout status deployment/ollama-agent-node --timeout=5m
      workspaces:
        - { name: manifest_dir, workspace: source }   # la tâche fait un cd dans ce dossier
```

- `sed` remplace `IMAGE_PLACEHOLDER` par l'image **désignée par son digest**, puis envoie le résultat à `oc apply -f -` (`-` = lire sur l'entrée standard).
- `oc rollout status` attend que le nouveau pod soit prêt, 5 minutes au plus. Si le pod ne démarre pas, la tâche échoue.

### `pipelinerun.yaml`

```yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  generateName: ollama-agent-node-     # préfixe ; le cluster ajoute un suffixe unique
spec:
  pipelineRef:
    name: ollama-agent-node            # quel pipeline exécuter
  # params:                            # décommenter pour changer un paramètre
  #   - name: git-revision
  #     value: <sha>
  taskRunTemplate:
    serviceAccountName: pipeline       # identité des pods des tâches
  workspaces:
    - name: source                     # branche le workspace "source" du pipeline…
      persistentVolumeClaim:
        claimName: pipeline-source     # … sur la PVC créée à l'étape 8
```

C'est ce fichier qui relie le pipeline à un disque réel. Lancé depuis la console, c'est le formulaire *Start* qui joue ce rôle, d'où le piège de l'« Empty Directory ».

---

## Et ensuite

L'installation est terminée. La suite est dans **[EXPLOITATION.md](EXPLOITATION.md)** :

| Besoin | Section |
|---|---|
| Déployer une nouvelle version | [Déploiements suivants](EXPLOITATION.md#déploiements-suivants) |
| Changer la configuration de l'appli (IP d'Ollama, mémoire…) | [Les manifestes `openshift/`](EXPLOITATION.md#les-manifestes-openshift) |
| Déployer une autre branche ou un ancien commit | [Paramètres du pipeline](EXPLOITATION.md#paramètres-du-pipeline), [Rollback](EXPLOITATION.md#rollback) |
| Un run échoue, le chat affiche une erreur | [En cas d'échec](EXPLOITATION.md#en-cas-déchec) |
| Le Mac ou CRC a redémarré | [Après un redémarrage](EXPLOITATION.md#après-un-redémarrage-mac-ou-crc) |
| Libérer de la place | [Faire le ménage dans les images](EXPLOITATION.md#faire-le-ménage-dans-les-images) |
| Tout supprimer | [Désinstaller](EXPLOITATION.md#désinstaller--repartir-de-zéro) |
| Comprendre les choix techniques | [Choix et pièges](EXPLOITATION.md#choix-et-pièges) |
