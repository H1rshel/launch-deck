import React, { useState, useRef, useEffect } from "react";
import { ChevronDown, Check } from "lucide-react";

export function Select({ value, onChange, options, className = "" }) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectedOption = options.find((opt) => opt.value === value);

  return (
    <div
      className={`custom-select ${isOpen ? "custom-select--open" : ""} ${className}`}
      ref={dropdownRef}
    >
      <button
        type="button"
        className={`custom-select__trigger ${isOpen ? "custom-select__trigger--active" : ""}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span>{selectedOption ? selectedOption.label : "Select..."}</span>
        <ChevronDown size={16} className={`custom-select__icon ${isOpen ? "custom-select__icon--open" : ""}`} />
      </button>

      {isOpen && (
        <div className="custom-select__dropdown">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`custom-select__option ${opt.value === value ? "custom-select__option--selected" : ""}`}
              onClick={() => {
                onChange(opt.value);
                setIsOpen(false);
              }}
            >
              <span>{opt.label}</span>
              {opt.value === value && <Check size={14} className="custom-select__check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
