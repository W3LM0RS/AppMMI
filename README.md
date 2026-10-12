# AppMMI — Gestion de brasserie

Application web pour gérer une brasserie artisanale :

- **Stocks** de bières (par format : bouteille, canette, fût…) et de matières premières (malt, houblon, levure, conditionnement…), avec alertes de stock minimum et inventaires (stock compté, casse, perte).
- **Achats** : matières premières (alimentent le stock), matériel et autres dépenses, avec plusieurs lignes par facture.
- **Production** : chaque lot consomme les matières selon la recette (modifiable au moment de la saisie) et ajoute les bières au stock.
- **Ventes** : sortie de stock, prix par défaut = prix de vente de la bière, marge calculée à chaque vente.
- **Tableau de bord** : chiffre d’affaires, coût des ventes, marge brute, achats par catégorie, valeur du stock, graphique mensuel, meilleures ventes.
- **Historique** de tous les mouvements de stock.

## Calcul automatique des coûts

| Élément | Méthode |
| --- | --- |
| Coût d’une matière première | Coût moyen pondéré (CMP), recalculé à chaque achat |
| Coût théorique d’une bière | Somme des matières de la recette × CMP ÷ nombre d’unités produites par la recette |
| Coût de revient d’un lot | (matières consommées au CMP + autres coûts : énergie, main d’œuvre…) ÷ quantité produite |
| Coût de revient d’une bière | CMP des lots produits (à défaut, coût théorique de la recette) |
| Marge d’une vente | Prix de vente HT − coût de revient des bières vendues |

Astuce : ajoutez bouteilles, capsules, étiquettes et cartons comme matières premières (catégorie « Conditionnement ») et dans vos recettes pour qu’ils soient inclus dans le coût de revient.

Tous les montants sont saisis **hors taxes**. Supprimer un achat, une production ou une vente rétablit les stocks.

## Lancer l’application

Prérequis : [Node.js](https://nodejs.org) 22.13 ou plus récent. Aucune dépendance à installer (base SQLite intégrée à Node).

```bash
npm start
```

Puis ouvrir <http://localhost:3000>.

Les données sont enregistrées dans `data/brasserie.db` (à sauvegarder régulièrement). Variables d’environnement optionnelles : `PORT` (défaut 3000) et `DB_FILE` (chemin de la base).

## Tests

```bash
npm test
```
