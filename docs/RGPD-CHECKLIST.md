# Checklist RGPD

Ce document n'est **pas un audit juridique** : c'est un point de départ technique et organisationnel pour tout projet dérivé de ce boilerplate. Il liste ce qui est déjà couvert par le code, ce qui reste un choix propre à chaque projet, et les gaps qui ne pouvaient pas être réglés directement ici (documentés au plus près du code concerné).

## 1. Déjà couvert par le template

- [x] Pseudonymat par défaut : un seul champ `username` unique, pas de nom/prénom réel collecté (minimisation par design).
- [x] Mots de passe hashés (bcrypt, `server/src/routes/auth/index.ts`), jamais stockés en clair.
- [x] `SESSION_SECRET` externalisé en variable d'environnement, obligatoire en production (`server/src/config/cache.config.ts`).
- [x] En-têtes de sécurité HTTP (Helmet) et rate limiting sur les routes d'authentification (`server/src/middleware/rateLimiter.middleware.ts`).
- [x] Validation stricte des entrées (schémas Zod) sur l'inscription et la rectification.
- [x] **Droit d'accès / portabilité** : `GET /api/auth/me/export` télécharge l'intégralité des données de l'utilisateur connecté.
- [x] **Droit de rectification** : `PATCH /api/auth/me` permet de modifier son propre `username`.
- [x] **Droit à l'effacement** : `DELETE /api/auth/me` (self-service) anonymise réellement le compte (`server/src/utils/anonymizeUser.ts`) — irréversible, distinct de la simple désactivation (`isActive`).

## 2. Back-office (absent de ce module)

Ce module n'a pas de partie admin. Si l'app hôte en ajoute une, l'accès admin est lui-même un traitement de données personnelles à encadrer :

- [ ] Minimisation des champs visibles (jamais `password` ni `googleId`), traçabilité de chaque action (journal d'audit), effacement admin passant par `anonymizeUser`.
- [ ] **Moindre privilège / granularité des rôles**, **authentification renforcée (2FA)** et **revue périodique des accès** : voir [server/src/middleware/README.md](../server/src/middleware/README.md#rgpd--%C3%A0-pr%C3%A9voir-selon-le-projet).

## 3. Droits des personnes concernées

Couverts (voir section 1). Reste hors périmètre :

- [ ] **Droit d'opposition / retrait du consentement** : dépend des traitements ajoutés par le projet (emailing, tracking...) — non applicable au boilerplate de base tel quel.

## 4. Sécurité des données (Art. 32 RGPD)

- [x] Mots de passe hashés, secrets en variables d'environnement, validation des entrées, rate limiting (section 1).
- [ ] **Chiffrement au repos, sauvegardes, localisation des sous-traitants** : dépendent de l'hébergeur — voir [server/src/config/README.md](../server/src/config/README.md#rgpd--%C3%A0-pr%C3%A9voir-selon-le-projet).
- [ ] **HTTPS en production** : voir la section Docker du [README.md](../README.md) racine.
- [x] **Journalisation** : les erreurs loggées (`error.middleware.ts`) ne contiennent pas `req.body`, donc pas de mot de passe en clair dans les logs actuels — à garder en tête si des logs plus détaillés sont ajoutés plus tard.

## 5. Organisationnel — à décider par projet (pas de "bon endroit" dans le code)

- [ ] Base légale du traitement et finalités documentées (registre des traitements).
- [ ] Durée de conservation des données définie (à partir de quand un compte inactif doit-il être anonymisé automatiquement ?).
- [ ] Désignation d'un DPO si le volume/la nature des données l'exige.
- [ ] Politique de confidentialité et mentions légales publiées (pas de page dédiée dans ce template).
- [ ] Contrats de sous-traitance (DPA) avec l'hébergeur.
- [ ] Procédure de notification de violation de données sous 72h (Art. 33/34).
