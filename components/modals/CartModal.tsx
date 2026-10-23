import React from 'react';
import { OrderItem, MenuItem, Language } from '../../types';
import { X, Plus, Minus, Trash2, ShoppingBag, ArrowRight } from 'lucide-react';
import { getItemPrice } from '../../utils/helpers';
import { translations } from '../../utils/translations';

interface CartModalProps {
  items: OrderItem[];
  discounts: any[];
  onClose: () => void;
  onUpdateQty: (item: MenuItem, qty: number, mode?: 'delta' | 'set') => void;
  onRemove: (id: number) => void;
  onCheckout: () => void;
  language: Language;
}

const CartModal: React.FC<CartModalProps> = ({
  items, discounts, onClose, onUpdateQty, onRemove, onCheckout, language
}) => {
  const t = translations[language];

  const total = items.reduce((sum, item) => {
    const price = getItemPrice(item, discounts);
    return sum + (price * item.quantity);
  }, 0);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 max-w-2xl w-full shadow-2xl animate-in fade-in zoom-in duration-200 flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="flex justify-between items-center mb-6 pb-4 border-b">
          <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <ShoppingBag className="text-orange-600" /> {t.cart}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 bg-gray-100 p-2 rounded-full transition-colors">
            <X size={24} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto custom-scrollbar space-y-4 pr-2">
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-400">
              <ShoppingBag size={64} className="mb-4 opacity-20" />
              <p className="text-lg font-medium">{t.emptyCart}</p>
              <button onClick={onClose} className="mt-4 text-orange-600 font-bold hover:underline bg-orange-50 px-4 py-2 rounded-lg">
                {t.browseMenu}
              </button>
            </div>
          ) : (
            items.map(item => {
              const currentPrice = getItemPrice(item, discounts);
              const hasDiscount = currentPrice < item.price;

              return (
                <div key={item.id} className="flex flex-col sm:flex-row items-center gap-4 bg-gray-50 p-3 rounded-xl border border-gray-100 hover:border-orange-200 transition-colors">
                   {/* Image */}
                   <div className="w-full sm:w-20 h-20 rounded-lg bg-white overflow-hidden shrink-0 border border-gray-200">
                      {item.image ? (
                        <img src={item.image} alt={item.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-2xl">🍽️</div>
                      )}
                   </div>

                   {/* Details */}
                   <div className="flex-1 w-full text-center sm:text-start">
                      <h3 className="font-bold text-gray-800 text-lg">{item.name}</h3>
                      <div className="flex items-center justify-center sm:justify-start gap-2 text-sm mt-1">
                        {hasDiscount && <span className="text-gray-400 line-through">{t.currency} {item.price.toFixed(2)}</span>}
                        <span className="font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded-md">{t.currency} {currentPrice.toFixed(2)}</span>
                      </div>
                   </div>

                   {/* Controls */}
                   <div className="flex items-center gap-4 w-full sm:w-auto justify-between sm:justify-end">
                      <div className="flex items-center bg-white rounded-lg border border-gray-200 shadow-sm h-10">
                        <button
                          onClick={() => onUpdateQty(item, -1)}
                          className="w-10 h-full flex items-center justify-center text-red-500 hover:bg-red-50 rounded-r-lg transition-colors border-l"
                        >
                          <Minus size={18} />
                        </button>
                        <input
                            type="number"
                            min="1"
                            value={item.quantity}
                            onFocus={(e) => e.target.select()}
                            onChange={(e) => {
                                const val = parseInt(e.target.value);
                                if (!isNaN(val)) {
                                    onUpdateQty(item, val, 'set');
                                }
                            }}
                            className="w-14 h-full text-center font-bold text-gray-800 outline-none bg-transparent focus:bg-gray-50 transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          onClick={() => onUpdateQty(item, 1)}
                          className="w-10 h-full flex items-center justify-center text-green-500 hover:bg-green-50 rounded-l-lg transition-colors border-r"
                        >
                          <Plus size={18} />
                        </button>
                      </div>

                      <div className="min-w-[80px] text-left font-bold text-orange-600 text-lg">
                        {t.currency} {(currentPrice * item.quantity).toFixed(2)}
                      </div>

                      <button
                        onClick={() => onRemove(item.id)}
                        className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                        title={t.delete}
                      >
                        <Trash2 size={20} />
                      </button>
                   </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        {items.length > 0 && (
          <div className="mt-6 pt-4 border-t bg-gray-50/50 -mx-6 -mb-6 p-6 rounded-b-2xl">
            <div className="flex justify-between items-center mb-4">
              <span className="text-gray-600 font-bold text-lg">{t.total}:</span>
              <span className="text-3xl font-extrabold text-gray-900">{t.currency} {total.toFixed(2)}</span>
            </div>

            <button
              onClick={onCheckout}
              className="w-full bg-gradient-to-r from-gray-900 to-gray-800 text-white py-4 rounded-xl font-bold text-xl hover:from-black hover:to-gray-900 transition-all shadow-lg shadow-gray-200 flex items-center justify-center gap-3 active:scale-[0.99]"
            >
              <span>{t.continueToPayment}</span>
              <ArrowRight size={24} className="rtl:rotate-180" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default CartModal;