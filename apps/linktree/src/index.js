import { inject } from '@vercel/analytics';
import React from 'react';
import ReactDOM from 'react-dom';
import App from './App';
 
inject();

ReactDOM.render( < React.StrictMode >
    <App />
    </React.StrictMode>,
    document.getElementById('root')
);
