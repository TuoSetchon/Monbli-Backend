/* =====================================================================
   MonBli — Serveur de paiement (CinetPay -> Firestore)
   ---------------------------------------------------------------------
   Ce serveur est le SEUL endroit autorisé à activer un abonnement.
   Le téléphone du client ne peut jamais le faire lui-même (voir les
   règles de sécurité Firestore : write sur "subscriptions" refusé
   partout ailleurs).

   Variables d'environnement attendues (à définir sur Render, jamais
   dans le code ni sur GitHub) :
     CINETPAY_APIKEY
     CINETPAY_SITE_ID
     FIREBASE_SERVICE_ACCOUNT_KEY   (le JSON complet du compte de service, en une seule ligne)
     PUBLIC_APP_URL                 (ex: https://monbli.onrender.com)
     PUBLIC_BACKEND_URL             (ex: https://monbli-backend.onrender.com)
   ===================================================================== */

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

const {
  CINETPAY_APIKEY,
  CINETPAY_SITE_ID,
  FIREBASE_SERVICE_ACCOUNT_KEY,
  PUBLIC_APP_URL,
  PUBLIC_BACKEND_URL,
  PORT
} = process.env;

const PRICES = { client: 1500, driver: 3000 }; // FCFA / mois

// ---- Initialisation Firebase Admin ----
if (!FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT_KEY manquante — le serveur ne pourra pas écrire dans Firestore.');
} else {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT_KEY))
  });
}
const db = admin.apps.length ? admin.firestore() : null;

app.get('/', (req, res) => res.send('MonBli payment server — OK'));

/* -----------------------------------------------------------------
   1) Le client/chauffeur demande à s'abonner : on crée une transaction
      CinetPay et on renvoie l'URL de paiement.
   ----------------------------------------------------------------- */
app.post('/api/subscribe', async (req, res) => {
  try {
    const { uid, role, phone, name } = req.body;
    if (!uid || !role || !PRICES[role]) {
      return res.status(400).json({ error: 'Paramètres manquants ou rôle invalide' });
    }
    const transactionId = `monbli-${role}-${uid}-${Date.now()}`;

    // On mémorise la transaction en attente pour retrouver l'uid/role au webhook
    if (db) {
      await db.collection('pendingPayments').doc(transactionId).set({
        uid, role, phone: phone || '', createdAt: Date.now(), status: 'pending'
      });
    }

    const payload = {
      apikey: CINETPAY_APIKEY,
      site_id: CINETPAY_SITE_ID,
      transaction_id: transactionId,
      amount: PRICES[role],
      currency: 'XOF',
      description: `Abonnement MonBli ${role === 'client' ? 'usager' : 'taxi-maître'} — 30 jours`,
      customer_name: name || '',
      customer_phone_number: phone || '',
      notify_url: `${PUBLIC_BACKEND_URL}/api/cinetpay/webhook`,
      return_url: `${PUBLIC_APP_URL}/?paiement=retour`,
      channels: 'ALL',
      lang: 'FR'
    };

    const r = await fetch('https://api-checkout.cinetpay.com/v2/payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await r.json();

    if (data.code !== '201') {
      console.error('Erreur CinetPay:', data);
      return res.status(502).json({ error: "Échec de l'initialisation du paiement", detail: data.message || data });
    }

    res.json({ payment_url: data.data.payment_url, transaction_id: transactionId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* -----------------------------------------------------------------
   2) CinetPay confirme le paiement ici (server-to-server). On vérifie
      le statut réel avant d'activer quoi que ce soit — on ne fait
      JAMAIS confiance à un simple appel entrant sans re-vérification.
   ----------------------------------------------------------------- */
app.post('/api/cinetpay/webhook', async (req, res) => {
  try {
    const transactionId = req.body.cpm_trans_id || req.body.transaction_id;
    if (!transactionId) return res.sendStatus(400);

    const check = await fetch('https://api-checkout.cinetpay.com/v2/payment/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: CINETPAY_APIKEY, site_id: CINETPAY_SITE_ID, transaction_id: transactionId })
    });
    const result = await check.json();

    if (result.data && result.data.status === 'ACCEPTED' && db) {
      const pendingRef = db.collection('pendingPayments').doc(transactionId);
      const pendingSnap = await pendingRef.get();
      if (pendingSnap.exists) {
        const { uid, role } = pendingSnap.data();
        const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
        await db.collection('subscriptions').doc(uid).set({
          role, active: true, expiresAt, method: result.data.payment_method || 'inconnu',
          activatedAt: Date.now(), transactionId
        });
        await pendingRef.update({ status: 'confirmed' });
        console.log(`✅ Abonnement activé pour ${uid} (${role})`);
      }
    } else {
      console.log('Paiement non confirmé pour', transactionId, result.data && result.data.status);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

const port = PORT || 3000;
app.listen(port, () => console.log(`MonBli payment server sur le port ${port}`));
