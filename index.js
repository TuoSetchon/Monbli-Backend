/* =====================================================================
   MonBli — Serveur de paiement (CinetPay -> Firestore)
   ---------------------------------------------------------------------
   Ce serveur est le SEUL endroit autorisé à activer un abonnement.
   Le téléphone du client ne peut jamais le faire lui-même (voir les
   règles de sécurité Firestore : write sur "subscriptions" refusé
   partout ailleurs).

   Utilise la nouvelle API CinetPay (clé "sk_test_"/"sk_live_" +
   authentification OAuth), l'ancienne adresse api-checkout.cinetpay.com
   n'étant plus joignable.

   Variables d'environnement attendues (à définir sur Render, jamais
   dans le code ni sur GitHub) :
     CINETPAY_API_KEY        (la clé "sk_test_..." ou "sk_live_...")
     CINETPAY_API_PASSWORD   (le mot de passe API associé)
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
  CINETPAY_API_KEY,
  CINETPAY_API_PASSWORD,
  FIREBASE_SERVICE_ACCOUNT_KEY,
  PUBLIC_APP_URL,
  PUBLIC_BACKEND_URL,
  PORT
} = process.env;

const PRICES = { client: 1500, driver: 3000 }; // FCFA / mois
const CINETPAY_BASE = (CINETPAY_API_KEY || '').startsWith('sk_live_')
  ? 'https://api.cinetpay.co'
  : 'https://api.cinetpay.net';

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

// ---- Jeton d'accès CinetPay (mis en cache le temps de sa validité) ----
let cachedToken = null, cachedTokenExpiry = 0;
async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;
  const r = await fetch(`${CINETPAY_BASE}/v1/oauth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: CINETPAY_API_KEY, api_password: CINETPAY_API_PASSWORD })
  });
  const data = await r.json();
  if (!data.access_token) {
    console.error('Échec authentification CinetPay:', data);
    throw new Error("Authentification CinetPay échouée");
  }
  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + 22 * 60 * 60 * 1000; // ~22h, avant les 23h de validité annoncées
  return cachedToken;
}

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

    if (db) {
      await db.collection('pendingPayments').doc(transactionId).set({
        uid, role, phone: phone || '', createdAt: Date.now(), status: 'pending'
      });
    }

    const token = await getAccessToken();
    const r = await fetch(`${CINETPAY_BASE}/v1/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        merchant_transaction_id: transactionId,
        amount: PRICES[role],
        currency: 'XOF',
        designation: `Abonnement MonBli ${role === 'client' ? 'usager' : 'taxi-maître'} — 30 jours`,
        client_phone: phone || '',
        client_first_name: (name || '').split(' ')[0] || 'Client',
        client_last_name: (name || '').split(' ').slice(1).join(' ') || 'MonBli',
        success_url: `${PUBLIC_APP_URL}/?paiement=succes`,
        failed_url: `${PUBLIC_APP_URL}/?paiement=echec`,
        notify_url: `${PUBLIC_BACKEND_URL}/api/cinetpay/webhook`,
        lang: 'fr'
      })
    });
    const data = await r.json();
    console.log('Réponse CinetPay /v1/payment:', JSON.stringify(data));

    const paymentUrl = data.paymentUrl || data.payment_url || (data.data && (data.data.paymentUrl || data.data.payment_url));
    if (!paymentUrl) {
      return res.status(502).json({ error: "Échec de l'initialisation du paiement", detail: data });
    }
    res.json({ payment_url: paymentUrl, transaction_id: transactionId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* -----------------------------------------------------------------
   2) CinetPay confirme le paiement ici (server-to-server). On vérifie
      le statut réel avant d'activer quoi que ce soit.
   ----------------------------------------------------------------- */
app.post('/api/cinetpay/webhook', async (req, res) => {
  try {
    const transactionId = req.body.merchant_transaction_id || req.body.cpm_trans_id || req.body.transaction_id;
    if (!transactionId) return res.sendStatus(400);

    const token = await getAccessToken();
    const check = await fetch(`${CINETPAY_BASE}/v1/payment/${encodeURIComponent(transactionId)}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const result = await check.json();
    console.log('Vérification statut CinetPay:', JSON.stringify(result));

    if (result.status === 'SUCCESS' && db) {
      const pendingRef = db.collection('pendingPayments').doc(transactionId);
      const pendingSnap = await pendingRef.get();
      if (pendingSnap.exists) {
        const { uid, role } = pendingSnap.data();
        const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
        await db.collection('subscriptions').doc(uid).set({
          role, active: true, expiresAt, activatedAt: Date.now(), transactionId
        });
        await pendingRef.update({ status: 'confirmed' });
        console.log(`✅ Abonnement activé pour ${uid} (${role})`);
      }
    } else {
      console.log('Paiement non confirmé pour', transactionId, result.status);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

const port = PORT || 3000;
app.listen(port, () => console.log(`MonBli payment server sur le port ${port}`));

