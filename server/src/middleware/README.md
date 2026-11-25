# Middlewares

| Fichier | Rôle |
|---------|------|
| `auth.middleware.ts` | `isAuth` (session active requise, compte actif) |
| `validate.middleware.ts` | `validateBody(schema)` — valide `req.body` avec un schéma Zod, renvoie `400` sinon |
| `error.middleware.ts` | Handler d'erreur centralisé, formate la réponse à partir d'une `AppError` ou renvoie `500` générique |
| `rateLimiter.middleware.ts` | `authLimiter` — limite les tentatives sur `/auth/login` et `/auth/register` |

Voir aussi [docs/RGPD-CHECKLIST.md](../../../docs/RGPD-CHECKLIST.md) pour la checklist complète.

## RGPD — à prévoir selon le projet

Ce qui suit dépend trop du contexte projet pour être dans le boilerplate par défaut, mais s'accroche directement à ces middlewares :

- **Rôles** : la colonne `role` existe sur `User` (défaut `ROLE_USER`) mais aucun middleware ne la vérifie, ce module n'a pas de back-office. Si l'app hôte en ajoute un : un middleware `hasRole(...roles)` à côté de `isAuth`, des rôles fins plutôt qu'un accès admin complet par défaut (moindre privilège), et une revue périodique de qui détient quel rôle.
- **2FA** : si des comptes à privilèges apparaissent, ajouter un TOTP (`otplib` ou `speakeasy`) — champ `twoFactorSecret` sur `User`, vérification à brancher entre `passport.authenticate("local")` et la création de session (route `/auth/2fa/verify`).
