import React, { useState } from 'react';
import { X, Check, CreditCard } from 'lucide-react';
import { translations } from '../../utils/translations';
import { Language } from '../../types';

interface CheckoutModalProps {
  onComplete: (paymentMethod: string, orderSource: string, orderType: string, notes: string, needsDelivery: boolean) => void;
  onCancel: () => void;
  language: Language;
}

const CheckoutModal: React.FC<CheckoutModalProps> = ({ onComplete, onCancel, language }) => {
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [orderSource, setOrderSource] = useState('salon');
  const [orderType, setOrderType] = useState('dine_in');
  const [needsDelivery, setNeedsDelivery] = useState(false);
  const [notes, setNotes] = useState('');

  const t = translations[language];

  const handleComplete = () => {
    onComplete(paymentMethod, orderSource, orderType, notes, needsDelivery);
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto" onClick={onCancel}>
      <div className="bg-white rounded-2xl p-6 max-w-lg w-full shadow-2xl animate-in fade-in zoom-in duration-200" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="flex justify-between items-center mb-6 pb-4 border-b">
          <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <CreditCard className="text-green-600" /> {t.checkout}
          </h2>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 bg-gray-100 p-2 rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
                <label className="block text-sm font-bold mb-2 text-gray-700">{t.paymentMethod}</label>
                <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    className="w-full p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-green-500 outline-none bg-white transition-all"
                >
                    <option value="cash">💵 {t.cash} (Dinheiro)</option>
                    <option value="pix">📱 Pix</option>
                    <option value="cartao">💳 {t.card} (Cartão)</option>
                    <option value="ifood_card">🍔 iFood Card</option>
                </select>
            </div>

            <div>
                <label className="block text-sm font-bold mb-2 text-gray-700">{t.orderSource}</label>
                <select
                    value={orderSource}
                    onChange={(e) => setOrderSource(e.target.value)}
                    className="w-full p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-green-500 outline-none bg-white transition-all"
                >
                    <option value="salon">🏪 {t.dineIn}</option>
                    <option value="whatsapp">📱 WhatsApp</option>
                    <option value="ifood">🍔 iFood</option>
                    <option value="delivery_mush">🚗 Delivery Mush</option>
                    <option value="amo_oferta">🎁 Amo Oferta</option>
                </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-bold mb-2 text-gray-700">{t.orderType}</label>
            <div className="flex gap-2">
                <button
                    onClick={() => { setOrderType('dine_in'); setNeedsDelivery(false); }}
                    className={`flex-1 py-3 px-3 rounded-xl border-2 transition-all font-bold text-sm ${orderType === 'dine_in' ? 'border-blue-500 bg-blue-50 text-blue-700 shadow-sm' : 'border-gray-100 text-gray-500 hover:bg-gray-50'}`}
                >
                    🍽️ {t.dineIn}
                </button>
                <button
                    onClick={() => { setOrderType('takeaway'); setNeedsDelivery(false); }}
                    className={`flex-1 py-3 px-3 rounded-xl border-2 transition-all font-bold text-sm ${orderType === 'takeaway' ? 'border-blue-500 bg-blue-50 text-blue-700 shadow-sm' : 'border-gray-100 text-gray-500 hover:bg-gray-50'}`}
                >
                    🥡 {t.takeaway}
                </button>
                <button
                    onClick={() => { setOrderType('delivery'); setNeedsDelivery(true); }}
                    className={`flex-1 py-3 px-3 rounded-xl border-2 transition-all font-bold text-sm ${orderType === 'delivery' ? 'border-orange-500 bg-orange-50 text-orange-700 shadow-sm' : 'border-gray-100 text-gray-500 hover:bg-gray-50'}`}
                >
                    🚗 {t.delivery}
                </button>
            </div>
          </div>

          {orderType !== 'delivery' && (
              <label className="flex items-center gap-3 p-4 bg-orange-50 rounded-xl cursor-pointer border border-orange-100 hover:bg-orange-100 transition-colors">
                <input
                    type="checkbox"
                    checked={needsDelivery}
                    onChange={(e) => setNeedsDelivery(e.target.checked)}
                    className="w-5 h-5 text-orange-600 rounded focus:ring-orange-500"
                />
                <span className="font-bold text-orange-800 text-sm">{t.deliverySpecial}</span>
              </label>
          )}

          <div>
            <label className="block text-sm font-bold mb-2 text-gray-700">{t.notes}</label>
            <textarea
                placeholder="..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full p-4 border border-gray-200 rounded-xl focus:ring-2 focus:ring-green-500 outline-none resize-none bg-white h-24 text-sm"
            />
          </div>

          <div className="flex gap-3 pt-4 border-t">
            <button onClick={onCancel} className="flex-1 bg-gray-100 text-gray-700 px-4 py-3.5 rounded-xl font-bold hover:bg-gray-200 transition-colors">
              {t.cancel}
            </button>
            <button onClick={handleComplete} className="flex-[2] bg-green-600 text-white px-4 py-3.5 rounded-xl font-bold hover:bg-green-700 transition-all shadow-lg shadow-green-200 flex items-center justify-center gap-2 active:scale-[0.98]">
              <Check size={20} />
              {t.confirmOrder}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CheckoutModal;