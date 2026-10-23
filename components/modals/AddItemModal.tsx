
import React, { useState } from 'react';
import { MenuItem, Language } from '../../types';
import { CATEGORIES, SPECIAL_MENU_CATEGORY } from '../../utils/helpers';
import { translations } from '../../utils/translations';
import { X, Upload, Zap } from 'lucide-react';

interface AddItemModalProps {
  onClose: () => void;
  onAdd: (item: Omit<MenuItem, 'id'>) => void;
  showSpecialCategory?: boolean;
  language: Language;
}

const AddItemModal: React.FC<AddItemModalProps> = ({ onClose, onAdd, showSpecialCategory, language }) => {
  const [newItem, setNewItem] = useState<Omit<MenuItem, 'id'>>({ name: '', price: 0, image: '', category: CATEGORIES[0], description: '' });
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [localCategories, setLocalCategories] = useState(CATEGORIES);

  const t = translations[language];

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          setNewItem({ ...newItem, image: result });
          setImagePreview(result);
        };
        reader.readAsDataURL(file);
      } else {
        alert('⚠️ Error file type');
      }
    }
  };

  const handleAdd = () => {
    if (newItem.name && newItem.price) {
      onAdd(newItem);
      onClose();
    }
  };

  const handleAddNewCategory = () => {
      if(newCategoryName.trim()) {
          setLocalCategories([...localCategories, newCategoryName]);
          setNewItem({...newItem, category: newCategoryName});
          setShowNewCategory(false);
          setNewCategoryName('');
      }
  }

  // Inject special category if enabled
  const displayCategories = showSpecialCategory ? [SPECIAL_MENU_CATEGORY, ...localCategories] : localCategories;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl animate-in fade-in zoom-in duration-200" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-orange-600 flex items-center gap-2">
            <span>➕</span> {t.addItem}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <X size={24} />
          </button>
        </div>

        <div className="space-y-4">
          <input
            type="text"
            placeholder={t.itemName}
            value={newItem.name}
            onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
            className="w-full p-3 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 focus:border-transparent outline-none transition-all"
          />
          <input
            type="number"
            step="0.01"
            placeholder={`${t.price} (${t.currency})`}
            value={newItem.price || ''}
            onChange={(e) => setNewItem({ ...newItem, price: parseFloat(e.target.value) })}
            className="w-full p-3 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 focus:border-transparent outline-none transition-all"
          />

          <div className="flex flex-col gap-2">
            <label className="text-sm font-bold text-gray-700">{t.category}</label>
            <div className="relative">
                <select
                    value={newItem.category}
                    onChange={(e) => setNewItem({ ...newItem, category: e.target.value })}
                    className={`w-full p-3 border rounded-xl focus:ring-2 outline-none appearance-none ${newItem.category === SPECIAL_MENU_CATEGORY ? 'border-purple-300 bg-purple-50 text-purple-800 ring-purple-500' : 'border-gray-200 focus:ring-orange-500 bg-white'}`}
                >
                    {displayCategories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                {newItem.category === SPECIAL_MENU_CATEGORY && (
                    <Zap size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-purple-600 pointer-events-none" />
                )}
            </div>

            <button
                type="button"
                onClick={() => setShowNewCategory(!showNewCategory)}
                className="text-sm text-blue-600 hover:underline self-start"
            >
                + {t.category}
            </button>
            {showNewCategory && (
                <div className="flex gap-2">
                    <input
                        type="text"
                        className="flex-1 p-2 border rounded-lg bg-white"
                        placeholder={t.category}
                        value={newCategoryName}
                        onChange={e => setNewCategoryName(e.target.value)}
                    />
                    <button onClick={handleAddNewCategory} className="bg-blue-600 text-white px-3 rounded-lg">{t.add}</button>
                </div>
            )}
          </div>

          <textarea
            placeholder={`${t.description} (Optional)`}
            value={newItem.description || ''}
            onChange={(e) => setNewItem({ ...newItem, description: e.target.value })}
            className="w-full p-3 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none resize-none"
            rows={2}
          />

          <div className="border-2 border-dashed border-gray-200 rounded-xl p-4 transition-colors hover:border-orange-300">
            <label className="flex flex-col items-center justify-center gap-2 cursor-pointer">
                <div className="bg-blue-50 p-3 rounded-full text-blue-600">
                    <Upload size={24} />
                </div>
                <span className="font-semibold text-gray-600">{t.uploadImage}</span>
                <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
            </label>
            <input
                type="text"
                placeholder="URL"
                value={newItem.image && !newItem.image.startsWith('data:') ? newItem.image : ''}
                onChange={(e) => {
                    setNewItem({ ...newItem, image: e.target.value });
                    setImagePreview(e.target.value || null);
                }}
                className="w-full mt-3 p-2 text-sm border rounded-lg bg-white"
            />
          </div>

          {(imagePreview || (newItem.image && !newItem.image.startsWith('data:'))) && (
            <div className="relative group">
              <img
                src={newItem.image || imagePreview || ''}
                alt="preview"
                className="w-full h-40 object-cover rounded-xl border border-gray-200"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
              <button
                onClick={() => {
                  setNewItem({ ...newItem, image: '' });
                  setImagePreview(null);
                }}
                className="absolute top-2 right-2 bg-red-500 text-white p-1.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X size={16} />
              </button>
            </div>
          )}

          <div className="flex gap-3 mt-6">
            <button onClick={onClose} className="flex-1 bg-gray-100 text-gray-700 px-4 py-3 rounded-xl font-bold hover:bg-gray-200 transition-colors">
              {t.cancel}
            </button>
            <button onClick={handleAdd} className="flex-1 bg-orange-600 text-white px-4 py-3 rounded-xl font-bold hover:bg-orange-700 transition-colors shadow-lg shadow-orange-200">
              {t.add}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AddItemModal;
