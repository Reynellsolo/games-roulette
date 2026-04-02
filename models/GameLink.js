const mongoose = require('mongoose');

const gameLinkSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  tier: { type: String, enum: ['starter', 'bronze', 'silver', 'gold', 'diamond'], required: true },
  active: { type: Boolean, default: true },

  // Данные покупателя
  spinCompleted: { type: Boolean, default: false },
  excludeDuplicates: { type: Boolean, default: false },
  steamProfileUrl: { type: String, default: null },
  steamId: { type: String, default: null },
  steamName: { type: String, default: null },
  steamAvatar: { type: String, default: null },
  country: { type: String, default: null },
  customerName: { type: String, default: null },
  orderNumber: { type: String, default: null },

  // Доплата ДО рулетки (повышенный шанс)
  boosted: { type: Boolean, default: false },
  boostPaid: { type: Boolean, default: false },
  boostAmount: { type: Number, default: 0 },
  boostOrderId: { type: String, default: null },
  boostTransactionId: { type: String, default: null },
  boostPaymentUrl: { type: String, default: null },
  boostPreparedAt: { type: Date, default: null },

  // Доплата ПОСЛЕ (перекрутка)
  respinRequested: { type: Boolean, default: false },
  respinType: {
    type: String,
    default: null,
    validate: {
      validator: (value) => value === null || ['normal', 'premium'].includes(value),
      message: 'respinType must be normal, premium or null'
    }
  },
  respinPaid: { type: Boolean, default: false },
  respinOrderId: { type: String, default: null },
  respinTransactionId: { type: String, default: null },
  respinCount: { type: Number, default: 0 },
  respinHistory: [{
    type: { type: String, enum: ['normal', 'premium'] },
    amount: { type: Number, default: 0 },
    paidAt: { type: Date, default: Date.now }
  }],
  respinOverlayDismissed: { type: Boolean, default: false },
  oldGameKey: { type: String, default: null },
  oldKeyWarningShown: { type: Boolean, default: false },
  respinNormalOrderId: { type: String, default: null },
  respinNormalTransactionId: { type: String, default: null },
  respinNormalPaymentUrl: { type: String, default: null },
  respinNormalPreparedAt: { type: Date, default: null },
  respinPremiumOrderId: { type: String, default: null },
  respinPremiumTransactionId: { type: String, default: null },
  respinPremiumPaymentUrl: { type: String, default: null },
  respinPremiumPreparedAt: { type: Date, default: null },

  // Ключ
  keyAssigned: { type: Boolean, default: false },
  keyRevealed: { type: Boolean, default: false },
  gameName: { type: String, default: null },
  gameKey: { type: String, default: null },
  steamAppId: { type: String, default: null },
  previousGameName: { type: String, default: null },
  previousGameKey: { type: String, default: null },
  previousSteamAppId: { type: String, default: null },
  oldKeyNeedsPickup: { type: Boolean, default: false },

  note: { type: String, default: '' }
}, { timestamps: true });

// ═══════ Индексы ═══════
gameLinkSchema.index({ spinCompleted: 1, keyAssigned: 1 });
gameLinkSchema.index({ tier: 1, active: 1 });
gameLinkSchema.index({ boostOrderId: 1 }, { sparse: true });
gameLinkSchema.index({ respinOrderId: 1 }, { sparse: true });
gameLinkSchema.index({ respinNormalOrderId: 1 }, { sparse: true });
gameLinkSchema.index({ respinPremiumOrderId: 1 }, { sparse: true });

module.exports = mongoose.model('GameLink', gameLinkSchema);
