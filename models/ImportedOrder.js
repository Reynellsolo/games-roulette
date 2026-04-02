const mongoose = require('mongoose');

const importedOrderSchema = new mongoose.Schema({
  gameName: { type: String, default: '' },
  gameKey: { type: String, default: '' },
  orderNumber: { type: String, default: null },
  customerName: { type: String, default: '' },
}, { timestamps: true });

importedOrderSchema.index({ customerName: 'text' });
importedOrderSchema.index({ orderNumber: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('ImportedOrder', importedOrderSchema);
