'use strict';

const mongoFields = document.getElementById('installer-mongo');
const storageOptions = document.querySelectorAll('input[name="storage"]');

if (mongoFields) {
  function updateStorage() {
    const mongodb = document.querySelector('input[name="storage"]:checked')?.value === 'mongodb';
    mongoFields.hidden = !mongodb;
    mongoFields.disabled = !mongodb;
  }
  for (const option of storageOptions) option.addEventListener('change', updateStorage);
  updateStorage();
}
