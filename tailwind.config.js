/** @type {import('tailwindcss').Config} */
export default {
    content: ['./src/web/public/**/*.{html,js}'],
    theme: {
        extend: {
            colors: {
                tg: {
                    blue: '#2AABEE',
                    darkBlue: '#229ED9',
                    bg: '#17212B',
                    sidebar: '#0E1621',
                    panel: '#242F3D',
                    hover: '#2B5278',
                    border: '#0D1117',
                    text: '#F5F5F5',
                    textSecondary: '#8B9BAA',
                    green: '#4FAE4E',
                    red: '#E53935',
                    orange: '#FF9800',
                    lightBg: '#182533',
                },
            },
        },
    },
    plugins: [],
};
